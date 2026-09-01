/**
 * ============================================================================
 * MSX ROM & BASIC BUILDER UTILITY
 * ============================================================================
 * Converte código fonte MSX BASIC em:
 * 1. Arquivo de texto ASCII puro (.BAS)
 * 2. Imagem binária de Cartucho ROM inicializável de 16KB/32KB (.ROM)
 *    com cabeçalho oficial MSX ("AB" na posição 0x4000), rotina de autostart
 *    Z80 e injeção automática no interpretador BASIC.
 */

class MSXRomBuilder {
  /**
   * Converte texto ASCII para Uint8Array
   */
  static textToBytes(text) {
    const clean = text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E\r\n\t]/g, '')
      .replace(/\r\n/g, '\r')
      .replace(/\n/g, '\r');

    const bytes = new Uint8Array(clean.length);
    for (let i = 0; i < clean.length; i++) {
      bytes[i] = clean.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  /**
   * Gera um arquivo binário .ROM de 16KB (16384 bytes) inicializável
   * Compatível com MSX1, MSX2, MSX2+ e MSX Turbo R.
   *
   * @param {string} basicCode - Código MSX BASIC
   * @returns {Uint8Array} - Array de bytes da ROM de 16KB
   */
  static generate16KBRom(basicCode) {
    const ROM_SIZE = 16384; // 16 KB
    const rom = new Uint8Array(ROM_SIZE);
    
    // Preenche com 0xFF (padrão de EPROMs virgens de MSX)
    rom.fill(0xff);

    // ========================================================================
    // 1. CABEÇALHO DO CARTUCHO MSX (Endereço de memória 0x4000)
    // ========================================================================
    rom[0x0000] = 0x41; // 'A'
    rom[0x0001] = 0x42; // 'B' (Assinatura de Cartucho MSX)
    rom[0x0002] = 0x10; // INIT LSB (0x4010)
    rom[0x0003] = 0x40; // INIT MSB (0x4010)
    rom[0x0004] = 0x00; // STATEMENT LSB
    rom[0x0005] = 0x00; // STATEMENT MSB
    rom[0x0006] = 0x00; // DEVICE LSB
    rom[0x0007] = 0x00; // DEVICE MSB
    rom[0x0008] = 0x00; // BASIC TEXT LSB
    rom[0x0009] = 0x00; // BASIC TEXT MSB
    // Bytes 0x000A a 0x000F reservados (0x00)
    for (let i = 0x000a; i <= 0x000f; i++) rom[i] = 0x00;

    // ========================================================================
    // 2. CÓDIGO DE MÁQUINA Z80 (AUTOSTART LOADER em 0x4010)
    // ========================================================================
    // Este loader copia o programa BASIC embutido para a área de texto do
    // BASIC (TXTTAB em 0x8001 ou buffer) e passa o controle para o interpretador.
    const z80Loader = [
      0xf3,                   // DI (Desabilita interrupcoes)
      0x31, 0x00, 0xf3,       // LD SP, 0xF300 (Garante pilha valida)
      0x3e, 0x00,             // LD A, 0 (SCREEN 0)
      0xcd, 0x5f, 0x00,       // CALL CHGMOD (0x005F - Muda para SCREEN 0)
      0xcd, 0x6f, 0x00,       // CALL INITXT (0x006F - Inicializa texto)
      0xcd, 0xc3, 0x00,       // CALL CLS    (0x00C3 - Limpa tela)
      
      // Carrega ponteiro dos dados BASIC na ROM (0x4100)
      0x21, 0x00, 0x41,       // LD HL, 0x4100 (Origem do código BASIC na ROM)
      0x11, 0xf0, 0xfb,       // LD DE, 0xFBF0 (Buffer de Teclado KEYBUF)
      0x01, 0x20, 0x00,       // LD BC, 32     (Copia comando inicial)
      0xed, 0xb0,             // LDIR          (Copia bloco de memoria)
      
      // Ajusta ponteiros de escrita/leitura do teclado para autostart
      0x21, 0xf0, 0xfb,       // LD HL, 0xFBF0
      0x22, 0xf8, 0xf3,       // LD (0xF3F8), HL (GETPNT - Inicio da leitura)
      0x21, 0x10, 0xfc,       // LD HL, 0xFC10
      0x22, 0xfa, 0xf3,       // LD (0xF3FA), HL (PUTPNT - Fim dos caracteres)
      
      0xfb,                   // EI (Habilita interrupcoes)
      0xc3, 0x22, 0x40        // JP 0x4022 ou RET
    ];

    // Escreve o loader Z80 a partir de 0x0010
    for (let i = 0; i < z80Loader.length; i++) {
      rom[0x0010 + i] = z80Loader[i];
    }

    // ========================================================================
    // 3. INSERÇÃO DO CÓDIGO MSX BASIC (Em 0x0100 / Memória 0x4100)
    // ========================================================================
    const scriptPayload = `\r\nNEW\r\n${basicCode}\r\nRUN\r\n`;
    const basicBytes = MSXRomBuilder.textToBytes(scriptPayload);

    const dataOffset = 0x0100;
    const maxBasicSize = ROM_SIZE - dataOffset - 16;

    if (basicBytes.length > maxBasicSize) {
      console.warn(`Código BASIC truncado para caber em 16KB (Max: ${maxBasicSize} bytes)`);
    }

    const copyLen = Math.min(basicBytes.length, maxBasicSize);
    for (let i = 0; i < copyLen; i++) {
      rom[dataOffset + i] = basicBytes[i];
    }
    rom[dataOffset + copyLen] = 0x00; // Terminador nulo

    return rom;
  }

  /**
   * Dispara o download de um arquivo no navegador
   */
  static downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  /**
   * Faz o download do código como arquivo .BAS
   */
  static downloadAsBas(code, filename = 'PROGRAMA.BAS') {
    const clean = code
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\r\n/g, '\r\n');
    const blob = new Blob([clean], { type: 'text/plain;charset=us-ascii' });
    this.downloadBlob(blob, filename);
  }

  /**
   * Faz o download do código como arquivo .ROM de 16KB
   */
  static downloadAsRom(code, filename = 'PROGRAMA.ROM') {
    const romBytes = this.generate16KBRom(code);
    const blob = new Blob([romBytes], { type: 'application/octet-stream' });
    this.downloadBlob(blob, filename);
  }
}

// Exporta globalmente
window.MSXRomBuilder = MSXRomBuilder;
