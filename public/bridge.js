/**
 * ============================================================================
 * WEBMSX <-> OLLAMA BRIDGE (Client-Side JS)
 * ============================================================================
 * Este script gerencia a comunicacao bidirecional entre o emulador WebMSX
 * e o backend Node.js que intermedeia as chamadas ao Ollama.
 * 
 * Mecanismos de Integracao:
 * 1. Hook no Virtual Printer do WebMSX: Captura comandos LPRINT "AI:..." do MSX BASIC.
 * 2. Injecao via WMSX.room.pasteText(): Digita a resposta formatada no buffer do MSX.
 * 3. Integracao com API REST do Node.js: /api/chat e /api/health.
 */

class WebMSXOllamaBridge {
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || '';
    this.currentModel = options.model || 'llama3';
    this.isProcessing = false;
    this.printerBuffer = '';
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onLog = options.onLog || console.log;

    this.init();
  }

  /**
   * Inicializa conexao com o backend e instala os hooks no WebMSX
   */
  async init() {
    this.onLog('[BRIDGE] Inicializando WebMSX-Ollama Bridge...');
    await this.checkHealth();
    this.installWebMSXHooks();
  }

  /**
   * Verifica status do servidor Node.js e do Ollama local
   */
  async checkHealth() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/health`);
      const data = await response.json();

      if (data.status === 'online') {
        this.onLog(`[BRIDGE] Conectado ao Node.js & Ollama (${data.models.length} modelos disponiveis)`);
        this.onStatusChange({ online: true, models: data.models, defaultModel: data.defaultModel });
        return data;
      } else {
        this.onLog(`[BRIDGE AVISO] Ollama offline: ${data.error || data.hint}`);
        this.onStatusChange({ online: false, error: data.error });
      }
    } catch (err) {
      this.onLog(`[BRIDGE ERRO] Nao foi possivel conectar ao servidor Node.js: ${err.message}`);
      this.onStatusChange({ online: false, error: err.message });
    }
  }

  /**
   * Obtem a instancia do WMSX (seja global ou dentro do iframe local)
   */
  getWMSX() {
    // 1. Verifica no window global
    if (window.WMSX && window.WMSX.room) return window.WMSX;
    if (window.wmsx && window.wmsx.Room) return window.wmsx;

    // 2. Verifica no iframe do WebMSX
    const iframe = document.getElementById('wmsx-frame');
    if (iframe && iframe.contentWindow) {
      try {
        const win = iframe.contentWindow;
        if (win.WMSX && win.WMSX.room) return win.WMSX;
        if (win.wmsx) return win.wmsx;
      } catch (e) {
        // Cross-origin restriction se nao for local
      }
    }
    return null;
  }

  /**
   * Instala hooks no WebMSX para interceptar saidas do emulador (LPRINT)
   * e preparar o canal de injecao de texto.
   */
  installWebMSXHooks() {
    const checkInterval = setInterval(() => {
      const wmsxObj = this.getWMSX();

      if (wmsxObj && (wmsxObj.room || wmsxObj.Machine || (wmsxObj.userPreferences && wmsxObj.room))) {
        clearInterval(checkInterval);
        this.onLog('[BRIDGE] Instancia do WebMSX detectada e pronta! Instalando hooks de I/O...');
        this.setupPrinterHook(wmsxObj);
      }
    }, 500);

    // Timeout de seguranca
    setTimeout(() => clearInterval(checkInterval), 30000);
  }

  /**
   * Intercepta a impressora virtual do WebMSX via barramento de I/O (Porta 0x91 - Printer Data).
   * Quando o MSX executa `LPRINT "AI:prompt"`, os bytes passam pela porta 0x91.
   */
  setupPrinterHook(wmsxObj) {
    const self = this;

    try {
      if (wmsxObj.room && wmsxObj.room.machine && wmsxObj.room.machine.bus) {
        const bus = wmsxObj.room.machine.bus;

        // Conecta na porta de saida de dados da impressora (I/O 0x91)
        if (typeof bus.connectOutputDevice === 'function') {
          bus.connectOutputDevice(0x91, function(val) {
            self.handlePrinterChar(val);
          });
          this.onLog('[BRIDGE] Hook de barramento I/O 0x91 (LPRINT) conectado com sucesso!');
        }

        // Conecta na porta de status da impressora (I/O 0x90) informando Bit 1 = 0 (READY / NOT BUSY)
        if (typeof bus.connectInputDevice === 'function') {
          bus.connectInputDevice(0x90, function() {
            return 0x00; // Bit 1 em nivel baixo (0) = Impressora Pronta (Not Busy)
          });
          this.onLog('[BRIDGE] Hook de barramento I/O 0x90 (Printer Ready Status: 0x00) ativo!');
        }

        return;
      }

      this.onLog('[BRIDGE] WebMSX em execucao. Bridge pronto para injecao direta.');
    } catch (e) {
      this.onLog(`[BRIDGE] Aviso ao instalar hook de impressora: ${e.message}. Modo manual disponivel.`);
    }
  }

  /**
   * Processa cada caractere recebido da porta de impressora virtual do MSX
   */
  handlePrinterChar(charCodeOrStr) {
    let char = '';
    if (typeof charCodeOrStr === 'number') {
      char = String.fromCharCode(charCodeOrStr);
    } else if (typeof charCodeOrStr === 'string') {
      char = charCodeOrStr;
    }

    if (char === '\n' || char === '\r') {
      const line = this.printerBuffer.trim();
      this.printerBuffer = '';

      if (line.length > 0) {
        this.onLog(`[MSX LPRINT] "${line}"`);
        this.processMSXCommand(line);
      }
    } else {
      this.printerBuffer += char;
    }
  }

  /**
   * Captura o texto atual exibido na tela/VDP do MSX
   */
  getScreenText() {
    try {
      const wmsx = this.getWMSX();
      if (wmsx && wmsx.room && wmsx.room.screen && typeof wmsx.room.screen.getScreenText === 'function') {
        return wmsx.room.screen.getScreenText() || '';
      }
      if (wmsx && wmsx.room && wmsx.room.machine && wmsx.room.machine.vdp && typeof wmsx.room.machine.vdp.getScreenText === 'function') {
        return wmsx.room.machine.vdp.getScreenText() || '';
      }
    } catch (e) {
      console.warn('Erro ao obter texto da tela do MSX:', e);
    }
    return '';
  }

  /**
   * Processa comandos interceptados vindos do MSX BASIC
   */
  async processMSXCommand(line) {
    // Verifica se a linha contem o prefixo de consulta a IA (AI: ou OLLAMA:)
    if (line.startsWith('AI:') || line.startsWith('OLLAMA:')) {
      const prompt = line.replace(/^(AI:|OLLAMA:)\s*/i, '').trim();
      this.onLog(`[BRIDGE] Prompt detectado do MSX BASIC: "${prompt}"`);
      await this.sendPromptToOllama(prompt);
    }
  }

  /**
   * Envia o prompt para o backend Node.js e injeta o resultado de volta no MSX
   */
  async sendPromptToOllama(prompt, model = this.currentModel) {
    if (this.isProcessing) {
      this.onLog('[BRIDGE] Aviso: Uma consulta ja esta em processamento.');
      return;
    }

    this.isProcessing = true;
    this.onLog(`[BRIDGE] Enviando prompt para Ollama (${model})...`);

    try {
      const response = await fetch(`${this.apiBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt,
          model: model,
          maxCols: 38
        })
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || `Erro HTTP ${response.status}`);
      }

      this.onLog(`[BRIDGE] Resposta recebida (${data.durationMs}ms, ${data.lines.length} linhas). Injetando no MSX...`);
      
      // Injeta a resposta diretamente na tela/teclado do MSX
      this.injectResponseIntoMSX(data.formattedResponse);

      return data;
    } catch (err) {
      this.onLog(`[BRIDGE ERRO] Falha ao consultar Ollama: ${err.message}`);
      this.injectResponseIntoMSX(`\r\n[ERRO]: ${err.message}\r\n`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Injeta o texto formatado no buffer de teclado do WebMSX
   */
  injectResponseIntoMSX(text) {
    const wmsxObj = this.getWMSX();

    if (!wmsxObj || !wmsxObj.room) {
      this.onLog('[BRIDGE ERRO] Instancia do WebMSX nao encontrada ou ainda carregando.');
      return false;
    }

    // Garante que o texto termine com Enter (\r) para completar o LINE INPUT
    const cleanText = text.replace(/[\r\n]+/g, ' ').trim();
    const payload = `${cleanText}\r`;

    // Metodo 1: DOMKeyboard typeString (API nativa oficial do WebMSX v6)
    if (wmsxObj.room.keyboard && typeof wmsxObj.room.keyboard.typeString === 'function') {
      wmsxObj.room.keyboard.typeString(payload);
      this.onLog('[BRIDGE] Resposta enviada ao MSX via keyboard.typeString()');
      return true;
    }

    // Metodo 2: MachineControls TYPE_STRING (Codigo 301)
    if (wmsxObj.room.machineControls && typeof wmsxObj.room.machineControls.processControlState === 'function') {
      wmsxObj.room.machineControls.processControlState(301, true, false, payload);
      this.onLog('[BRIDGE] Resposta enviada via machineControls.processControlState(TYPE_STRING)');
      return true;
    }

    // Metodo 3: Fallback pasteText
    if (typeof wmsxObj.room.pasteText === 'function') {
      wmsxObj.room.pasteText(payload);
      this.onLog('[BRIDGE] Texto injetado via WMSX.room.pasteText()');
      return true;
    }

    this.onLog('[BRIDGE ERRO] Nao foi possivel encontrar API de injecao de texto no WebMSX.');
    return false;
  }

  /**
   * Auto-digita e executa o programa CHAT.BAS no MSX
   */
  async autoLoadChatBas() {
    try {
      this.onLog('[BRIDGE] Carregando CHAT.BAS...');
      const response = await fetch(`${this.apiBaseUrl}/chat.bas`);
      const basCode = await response.text();
      
      const wmsxObj = this.getWMSX();
      if (!wmsxObj || !wmsxObj.room) {
        throw new Error('WebMSX ainda nao esta pronto. Aguarde o boot.');
      }

      // Envia comando para limpar a tela e cola o codigo BASIC com RUN no final
      const injectScript = `\r\nNEW\r\n${basCode}\r\nRUN\r\n`;

      if (wmsxObj.room.keyboard && typeof wmsxObj.room.keyboard.typeString === 'function') {
        wmsxObj.room.keyboard.typeString(injectScript);
        this.onLog('[BRIDGE] CHAT.BAS injetado e executado (RUN) no MSX via keyboard.typeString!');
        return;
      }

      if (wmsxObj.room.machineControls && typeof wmsxObj.room.machineControls.processControlState === 'function') {
        wmsxObj.room.machineControls.processControlState(301, true, false, injectScript);
        this.onLog('[BRIDGE] CHAT.BAS injetado e executado no MSX via machineControls!');
        return;
      }

      if (typeof wmsxObj.room.pasteText === 'function') {
        wmsxObj.room.pasteText(injectScript);
        this.onLog('[BRIDGE] CHAT.BAS injetado via pasteText!');
        return;
      }

      throw new Error('Nao foi possivel encontrar metodo de injecao de teclado.');
    } catch (e) {
      this.onLog(`[BRIDGE ERRO] Falha ao carregar CHAT.BAS: ${e.message}`);
    }
  }
}

// Exporta globalmente para uso na pagina web
window.WebMSXOllamaBridge = WebMSXOllamaBridge;
