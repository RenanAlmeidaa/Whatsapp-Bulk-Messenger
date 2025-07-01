const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');
const https = require('https');
const crypto = require('crypto');

const expressApp = express();
const server = http.createServer(expressApp);
const io = new Server(server);
const port = 3000;

// Diretório de uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const upload = multer({ dest: uploadsDir });

const log = msg => {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(__dirname, 'log.txt'), line + '\n');
};

// Verificação por ID único da máquina
const idPath = path.join(app.getPath('userData'), 'machine-id.txt');
let machineId;

if (fs.existsSync(idPath)) {
  machineId = fs.readFileSync(idPath, 'utf8');
} else {
  machineId = crypto.randomUUID();
  fs.writeFileSync(idPath, machineId);
  console.log('🆔 ID gerado para esta máquina:', machineId);
}

async function verificarAtivacao(id) {
  return new Promise((resolve) => {
    https.get('https://gist.githubusercontent.com/RenanAlmeidaa/2bd950942e9361cc9ceba588d627f28f/raw/controle-app.json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('🔎 JSON recebido do Gist:', json);
          console.log('🔍 Verificando ID da máquina:', id);
          const autorizado = json.autorizados.includes(id);
          console.log('✅ Autorizado?', autorizado);
          resolve(autorizado);
        } catch (e) {
          console.log('❌ Erro ao processar JSON:', e.message);
          resolve(false);
        }
      });
    }).on('error', (err) => {
      console.log('❌ Erro ao acessar o Gist:', err.message);
      resolve(false);
    });
  });
}


expressApp.use(express.static(path.join(__dirname, 'public')));
expressApp.use(express.json());
expressApp.use(express.urlencoded({ extended: true }));

let whatsappClient;
let pauseSending = false;
let stopSending = false;

expressApp.get('/status', (req, res) => {
  const connected = whatsappClient && whatsappClient.info?.wid;
  res.json({ ready: !!connected });
});

expressApp.get('/progresso', (req, res) => {
  const progressoPath = path.join(__dirname, 'progresso.json');
  if (fs.existsSync(progressoPath)) {
    const saved = JSON.parse(fs.readFileSync(progressoPath, 'utf-8'));
    res.json(saved);
  } else {
    res.json(null);
  }
});

expressApp.post('/enviar', upload.single('planilha'), async (req, res) => {
  try {
    if (!whatsappClient || !whatsappClient.info?.wid) {
      return res.status(500).json({ success: false, message: 'WhatsApp não conectado' });
    }

    if (!req.file) return res.status(400).json({ success: false, message: 'Arquivo não enviado' });

    const {
      mensagem1, mensagem2, mensagem3, opcaoMensagem,
      intervalMin, intervalMax
    } = req.body;

    pauseSending = false;
    stopSending = false;

    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const workbook = xlsx.readFile(filePath);
    const contatos = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

    const progressoPath = path.join(__dirname, 'progresso.json');
    let progresso = { fileName, index: 0 };

    if (fs.existsSync(progressoPath)) {
      const saved = JSON.parse(fs.readFileSync(progressoPath, 'utf-8'));
      if (saved.fileName === fileName) {
        progresso.index = saved.index;
      }
    }

    const escolheMensagem = () => {
      if (opcaoMensagem === '1') return mensagem1;
      if (opcaoMensagem === '2') return mensagem2;
      if (opcaoMensagem === '3') return mensagem3;
      const msgs = [mensagem1, mensagem2, mensagem3].filter(m => m && m.trim() !== '');
      return msgs[Math.floor(Math.random() * msgs.length)];
    };

    const minDelay = Math.max(Number(intervalMin), 3) * 60 * 1000;
    const maxDelay = Math.max(Number(intervalMax), minDelay / 60000) * 60 * 1000;

    io.emit('envio-status', { status: 'iniciado', total: contatos.length });

    for (let index = progresso.index + 1; index < contatos.length; index++) {
      if (stopSending) {
        log('Envio interrompido pelo usuário');
        io.emit('envio-status', { status: 'interrompido', message: 'Envio interrompido pelo usuário.' });
        break;
      }

      while (pauseSending) {
        await new Promise(r => setTimeout(r, 1000));
      }

      const linha = contatos[index];
      const numeroRaw = linha.CONTATO;
      const numeroLimpo = numeroRaw?.toString().replace(/\D/g, '');
      if (!numeroLimpo) {
        const erro = `❌ Número inválido na linha ${index + 2}`;
        log(erro);
        io.emit('envio-status', { status: 'erro', message: 'Número inválido (linha ' + (index + 2) + ')' });
        continue;
      }

      const numero = `55${numeroLimpo}@c.us`;
      const mensagemBase = escolheMensagem();
      const mensagem = mensagemBase.replace(/{([^}]+)}/g, (_, chave) => {
        return linha[chave] ?? `{${chave}}`;
      });

      try {
        const numberId = await whatsappClient.getNumberId(numero);
        if (!numberId) {
          const erro = `❌ Número ${numeroLimpo} não registrado`;
          log(erro);
          io.emit('envio-status', { status: 'erro', message: erro });
          continue;
        }

        await whatsappClient.sendMessage(numberId._serialized, mensagem);
        progresso.index = index;
        fs.writeFileSync(progressoPath, JSON.stringify(progresso));

        const sucesso = `✅ Mensagem enviada para ${numeroLimpo}`;
        log(sucesso);
        io.emit('envio-status', { status: 'enviado', message: sucesso });
      } catch (err) {
        const erro = `❌ Erro ao enviar para ${numeroLimpo}: ${err.message}`;
        log(erro);
        io.emit('envio-status', { status: 'erro', message: erro });
      }

      if (index < contatos.length - 1) {
        const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
        log(`⏳ Aguardando ${Math.floor(delay / 60000)} min...`);
        io.emit('envio-status', { status: 'esperando', message: `Aguardando ${Math.floor(delay / 60000)} min` });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (fs.existsSync(progressoPath)) fs.unlinkSync(progressoPath);
    io.emit('envio-status', { status: 'finalizado' });
    res.json({ success: true, message: 'Mensagens enviadas!' });

  } catch (err) {
    log('Erro no envio: ' + err.message);
    io.emit('envio-status', { status: 'erro', message: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

io.on('connection', socket => {
  socket.on('toggle-pause', (paused) => {
    pauseSending = paused;
    if (paused) {
      log('Envio pausado pelo usuário');
      io.emit('envio-status', { status: 'pausado', message: 'Envio pausado pelo usuário.' });
    } else {
      log('Envio retomado pelo usuário');
      io.emit('envio-status', { status: 'retomado', message: 'Envio retomado pelo usuário.' });
    }
  });

  socket.on('stop', () => {
    stopSending = true;
    pauseSending = false;
    log('Envio interrompido pelo usuário');
  });
});

const startWhatsApp = async () => {
  whatsappClient = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, 'session') }),
    puppeteer: {
      headless: true,
      executablePath: puppeteer.executablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  whatsappClient.on('qr', qr => {
    log('QR code recebido');
    io.emit('qr', qr);
  });

  whatsappClient.on('ready', () => {
    log('WhatsApp conectado');
    io.emit('ready');
  });

  whatsappClient.on('auth_failure', msg => log('Falha de autenticação: ' + msg));
  whatsappClient.on('disconnected', reason => log('Desconectado: ' + reason));

  log('Iniciando WhatsApp...');
  whatsappClient.initialize();
};

server.listen(port, () => {
  log(`Servidor rodando em http://localhost:${port}`);
  startWhatsApp();
});

let mainWindow;
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 850,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadURL(`http://localhost:${port}`);
  mainWindow.on('closed', () => mainWindow = null);
}

app.whenReady().then(async () => {
  const liberado = await verificarAtivacao(machineId);
  if (!liberado) {
    dialog.showErrorBox('Bloqueado', 'Este dispositivo não está autorizado a usar este aplicativo.');
    app.quit();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (mainWindow === null) createWindow(); });
