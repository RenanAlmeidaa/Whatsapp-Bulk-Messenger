const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');

const expressApp = express();
const server = http.createServer(expressApp);
const io = new Server(server);

const port = 3000;
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const upload = multer({ dest: uploadsDir });

const log = msg => {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(__dirname, 'log.txt'), line + '\n');
};

// Serve arquivos estáticos
expressApp.use(express.static(path.join(__dirname, 'public')));
expressApp.use(express.json());
expressApp.use(express.urlencoded({ extended: true }));

let whatsappClient;

// Endpoint status
expressApp.get('/status', (req, res) => {
  const connected = whatsappClient && whatsappClient.info?.wid;
  res.json({ ready: !!connected });
});

// Endpoint envio
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

    const filePath = req.file.path;
    const workbook = xlsx.readFile(filePath);
    const contatos = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

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

    for (const [index, linha] of contatos.entries()) {
      const numeroRaw = linha.CONTATO;
      const numeroLimpo = numeroRaw?.toString().replace(/\D/g, '');
      if (!numeroLimpo) {
        const erro = `❌ Número inválido na linha ${index + 2}`;
        log(erro);
        io.emit('envio-status', { status: 'erro', message: erro });
        continue;
      }

      const numero = `55${numeroLimpo}@c.us`;
      const mensagem = escolheMensagem();

      try {
        const numberId = await whatsappClient.getNumberId(numero);
        if (!numberId) {
          const erro = `❌ Número ${numeroLimpo} não registrado`;
          log(erro);
          io.emit('envio-status', { status: 'erro', message: erro });
          continue;
        }

        await whatsappClient.sendMessage(numberId._serialized, mensagem);
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

    io.emit('envio-status', { status: 'finalizado' });
    res.json({ success: true, message: 'Mensagens enviadas!' });

  } catch (err) {
    log('Erro no envio: ' + err.message);
    io.emit('envio-status', { status: 'erro', message: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
});

// Inicializa WhatsApp
const startWhatsApp = async () => {
  whatsappClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: path.join(__dirname, 'session')
    }),
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

  whatsappClient.on('auth_failure', msg => {
    log('Falha de autenticação: ' + msg);
  });

  whatsappClient.on('disconnected', reason => {
    log('Desconectado: ' + reason);
  });

  log('Iniciando WhatsApp...');
  whatsappClient.initialize();
};

// Start server Express
server.listen(port, () => {
  log(`Servidor rodando em http://localhost:${port}`);
  startWhatsApp();
});

// --- Código Electron ---

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 850,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js') // caso precise de preload
    }
  });

  // Abrir a página do Express no Electron
  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Fecha app no macOS só quando explicitamente fechar
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
