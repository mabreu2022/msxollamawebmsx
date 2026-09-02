const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const url = require('url');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'qwen2.5-coder:1.5b';

// Middlewares
app.use(cors({
  origin: '*', // Permite requisicoes do WebMSX / frontend local
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Cliente HTTP nativo para comunicacao com a API do Ollama.
 * Nao requer dependencias externas (axios/node-fetch).
 *
 * @param {string} endpoint - Caminho da API (ex: '/api/generate' ou '/api/tags')
 * @param {string} method - 'GET' ou 'POST'
 * @param {object|null} data - Corpo da requisicao JSON
 * @returns {Promise<object>}
 */
function queryOllama(endpoint, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = url.parse(`${OLLAMA_HOST}${endpoint}`);
    const isHttps = parsedUrl.protocol === 'https:';
    const httpLib = isHttps ? https : http;

    const payload = data ? JSON.stringify(data) : null;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 180000 // 3 minutos de timeout para carregar modelos
    };

    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = httpLib.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');

      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(body);
            resolve(json);
          } catch (e) {
            resolve({ raw: body });
          }
        } else {
          reject(new Error(`Ollama respondeu com HTTP ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Falha de conexao com Ollama (${OLLAMA_HOST}): ${err.message}`));
    });

    req.on('timeout', () => {
      req.abort();
      reject(new Error('Timeout aguardando resposta do Ollama'));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * Garante que apenas UM modelo fique carregado na VRAM da GPU NVIDIA de 4GB,
 * evitando que múltiplos modelos concorram pela memória e causem lentidão.
 */
async function ensureSingleModelLoaded(targetModel) {
  try {
    const psData = await queryOllama('/api/ps', 'GET');
    if (psData && psData.models) {
      for (const m of psData.models) {
        if (m.name !== targetModel && m.model !== targetModel) {
          console.log(`[VRAM OPTIMIZER] Descarregando modelo inativo "${m.name}" da GPU...`);
          await queryOllama('/api/generate', 'POST', {
            model: m.name,
            keep_alive: 0
          });
        }
      }
    }
  } catch (e) {
    // Silencia se o endpoint /api/ps falhar
  }
}

/**
 * Normaliza e sanitiza o texto retornado pelo LLM para compatibilidade com o charset do MSX.
 * Converte acentuacoes para ASCII simples, substitui pontuacoes especiais Unicode
 * e remove caracteres que nao existem no VDP/BIOS padrao do MSX (SCREEN 0).
 *
 * @param {string} text - Texto bruto retornado pelo Ollama
 * @returns {string} - Texto ASCII 7-bit compativel com MSX
 */
function sanitizeForMSX(text) {
  if (!text) return '';

  return text
    // 1. Decomposicao de acentos Unicode (NFD) e remocao de diacriticos
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // 2. Substituicao de aspas e pontuacoes especiais por equivalentes ASCII
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’`]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .replace(/\t/g, '  ')
    // 3. Remocao de emojis e simbolos fora do intervalo ASCII basico (32-126)
    .replace(/[^\x20-\x7E\r\n]/g, '')
    // 4. Normalizacao de quebras de linha
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * Aplica Word-Wrap estrito para largura especifica (padrao 38 colunas para SCREEN 0 do MSX,
 * deixando 2 caracteres de margem de seguranca).
 *
 * @param {string} text - Texto ASCII ja sanitizado
 * @param {number} maxCols - Largura maxima por linha (padrao 38)
 * @returns {string[]} - Array de linhas formatadas
 */
function wordWrapMSX(text, maxCols = 38) {
  const paragraphs = text.split('\n');
  const formattedLines = [];

  for (const paragraph of paragraphs) {
    if (paragraph.trim().length === 0) {
      formattedLines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (!word) continue;

      if (currentLine.length === 0) {
        // Se a palavra individual for maior que a linha, quebra a palavra
        if (word.length > maxCols) {
          let remaining = word;
          while (remaining.length > maxCols) {
            formattedLines.push(remaining.substring(0, maxCols));
            remaining = remaining.substring(maxCols);
          }
          currentLine = remaining;
        } else {
          currentLine = word;
        }
      } else if (currentLine.length + 1 + word.length <= maxCols) {
        currentLine += ' ' + word;
      } else {
        formattedLines.push(currentLine);
        if (word.length > maxCols) {
          let remaining = word;
          while (remaining.length > maxCols) {
            formattedLines.push(remaining.substring(0, maxCols));
            remaining = remaining.substring(maxCols);
          }
          currentLine = remaining;
        } else {
          currentLine = word;
        }
      }
    }

    if (currentLine.length > 0) {
      formattedLines.push(currentLine);
    }
  }

  return formattedLines;
}

/**
 * Rota: Health Check e Listagem de Modelos do Ollama
 */
app.get('/api/health', async (req, res) => {
  try {
    const data = await queryOllama('/api/tags', 'GET');
    res.json({
      status: 'online',
      ollamaHost: OLLAMA_HOST,
      models: data.models || [],
      defaultModel: DEFAULT_MODEL
    });
  } catch (error) {
    res.status(503).json({
      status: 'offline',
      ollamaHost: OLLAMA_HOST,
      error: error.message,
      hint: 'Certifique-se de que o Ollama esta rodando localmente (ollama serve).'
    });
  }
});

/**
 * Rota: Geracao de Resposta para o MSX
 */
app.post('/api/chat', async (req, res) => {
  const { prompt, model = DEFAULT_MODEL, maxCols = 38, systemPrompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'O prompt é obrigatório.' });
  }

  console.log(`[BRIDGE] Prompt recebido do MSX: "${prompt}" (Modelo: ${model})`);

  try {
    // Descarrega outros modelos inativos da VRAM de 4GB para velocidade máxima
    await ensureSingleModelLoaded(model);

    const baseSystemPrompt = systemPrompt || 
      'Voce e a IA do computador retro MSX (1983). ' +
      'Responda SEMPRE em no maximo 2 frases curtas, concisas e diretas, ' +
      'pois o display do MSX e pequeno (40 colunas). Nao use markdown.';

    const ollamaPayload = {
      model: model,
      prompt: prompt,
      system: baseSystemPrompt,
      stream: false,
      keep_alive: '60m',
      options: {
        num_gpu: 99,
        main_gpu: 0,
        num_ctx: 2048, // Otimizado para caber com folga na VRAM de 4GB
        temperature: 0.4,
        num_predict: 80,
        top_k: 40,
        top_p: 0.9
      }
    };

    const startTime = Date.now();
    const data = await queryOllama('/api/generate', 'POST', ollamaPayload);
    const durationMs = Date.now() - startTime;
    const rawResponse = data.response || '';

    // 1. Sanitiza para charset compativel com MSX (ASCII 7-bit sem diacriticos)
    let sanitized = sanitizeForMSX(rawResponse);
    if (sanitized.length > 240) {
      sanitized = sanitized.substring(0, 237) + '...';
    }

    // 2. Aplica Word-Wrap para 40 colunas (SCREEN 0)
    const lines = wordWrapMSX(sanitized, maxCols);
    const formattedResponse = lines.join('\r\n');

    console.log(`[BRIDGE] Resposta gerada em ${durationMs}ms (${lines.length} linhas formatadas para MSX)`);

    res.json({
      success: true,
      model: data.model,
      durationMs: durationMs,
      prompt: prompt,
      rawResponse: rawResponse,
      sanitized: sanitized,
      lines: lines,
      formattedResponse: formattedResponse,
      msxPayload: lines
    });

  } catch (error) {
    console.error(`[BRIDGE ERROR] Falha ao processar requisicao: ${error.message}`);
    
    const errorMsg = sanitizeForMSX(`ERRO BRIDGE: ${error.message}`);
    const errLines = wordWrapMSX(errorMsg, maxCols);

    res.status(500).json({
      success: false,
      error: error.message,
      sanitized: errorMsg,
      lines: errLines,
      formattedResponse: errLines.join('\r\n')
    });
  }
});

/**
 * Rota: Gerador Especializado de Código MSX BASIC
 * Gera código BASIC limpo, pronto para injeção ou compilação em .ROM.
 */
app.post('/api/generate-code', async (req, res) => {
  const { prompt, model = DEFAULT_MODEL } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'O prompt é obrigatório.' });
  }

  console.log(`[STUDIO] Gerando código MSX BASIC para: "${prompt}" (Modelo: ${model})`);

  try {
    // Descarrega outros modelos inativos da VRAM
    await ensureSingleModelLoaded(model);

    const codeSystemPrompt = 
      'Voce e um especialista em MSX BASIC (computador 8-bits Z80 de 1983). ' +
      'Crie um programa completo, direto e funcional em MSX BASIC compativel com MSX1 e MSX2. ' +
      'REGRAS ESTRITAS:\n' +
      '1. Use numeracao de linha obrigatoria (10, 20, 30...).\n' +
      '2. Use comandos em letras MAIUSCULAS (SCREEN, COLOR, CLS, PRINT, FOR, NEXT, IF, THEN, GOTO, GOSUB, RETURN, LOCATE, SOUND, PLAY, INPUT).\n' +
      '3. Nao use acentos ou caracteres especiais Unicode.\n' +
      '4. Retorne APENAS o codigo BASIC puro, sem textos explicativos, sem introducoes e sem blocos markdown extras.';

    const ollamaPayload = {
      model: model,
      prompt: prompt,
      system: codeSystemPrompt,
      stream: false,
      keep_alive: '60m',
      options: {
        num_gpu: 99,
        main_gpu: 0,
        num_ctx: 2048,
        temperature: 0.3, // Mais determinístico para código
        num_predict: 350
      }
    };

    const startTime = Date.now();
    const data = await queryOllama('/api/generate', 'POST', ollamaPayload);
    const durationMs = Date.now() - startTime;
    let raw = data.response || '';

    // Remove markdown code fences se existirem
    raw = raw.replace(/^```[a-z]*\n?/gim, '').replace(/\n?```$/gim, '').trim();

    // Sanitiza para ASCII puro
    const sanitizedCode = sanitizeForMSX(raw);

    console.log(`[STUDIO] Código gerado em ${durationMs}ms (${sanitizedCode.split('\n').length} linhas)`);

    res.json({
      success: true,
      code: sanitizedCode,
      model: data.model,
      durationMs: durationMs
    });

  } catch (error) {
    console.error(`[STUDIO ERROR] Falha ao gerar código: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Rota: Depurador e Corretor Automático de Código MSX BASIC
 * Recebe o código com erro + descrição do erro ou texto da tela do MSX e devolve o código corrigido.
 */
app.post('/api/fix-code', async (req, res) => {
  const { code, lastSentCode = '', errorPrompt = '', screenText = '', model = DEFAULT_MODEL } = req.body;

  const targetCode = code || lastSentCode;

  if (!targetCode) {
    return res.status(400).json({ error: 'Nenhum código foi fornecido ou encontrado na memória para correção.' });
  }

  console.log(`[DEBUGGER] Corrigindo código MSX BASIC (Memória de ${targetCode.split('\n').length} linhas) para erro: "${errorPrompt || screenText}" (Modelo: ${model})`);

  try {
    // Descarrega outros modelos inativos da VRAM
    await ensureSingleModelLoaded(model);

    const fixSystemPrompt = 
      'Voce e um depurador e especialista senior em MSX BASIC (1983, Z80).\n' +
      'Sua tarefa e analisar o codigo MSX BASIC fornecido pelo usuario (que foi o programa enviado e executado no emulador WebMSX), identificar e corrigir o erro relatado ou capturado da tela (ex: Syntax error, Type mismatch, Subscript out of range, Overflow, Out of string space, FOR/NEXT incorreto, problemas de VDP ou SCREEN, etc.).\n' +
      'REGRAS ESTRITAS:\n' +
      '1. Mantenha a numeracao de linhas (10, 20, 30...).\n' +
      '2. Use comandos em letras MAIUSCULAS compativeis com MSX1 e MSX2.\n' +
      '3. Nao use acentos ou caracteres especiais Unicode.\n' +
      '4. Se o erro for de string space, inclua CLEAR 4000 no inicio.\n' +
      '5. Retorne EXCLUSIVAMENTE o codigo MSX BASIC corrigido e 100% funcional, sem markdown, sem explicacoes e sem introducoes.';

    let userContent = '';
    if (lastSentCode && lastSentCode.trim() !== targetCode.trim()) {
      userContent += `ULTIMO CODIGO INJETADO NO MSX:\n${lastSentCode}\n\n`;
      userContent += `CODIGO ATUAL NO EDITOR:\n${targetCode}\n\n`;
    } else {
      userContent += `CODIGO EXECUTADO NO MSX COM ERRO:\n${targetCode}\n\n`;
    }

    if (errorPrompt) {
      userContent += `DESCRICAO DO ERRO / SOLICITACAO: ${errorPrompt}\n`;
    }
    if (screenText) {
      userContent += `TEXTO CAPTURADO DA TELA DO MSX:\n${screenText}\n`;
    }

    const ollamaPayload = {
      model: model,
      prompt: userContent,
      system: fixSystemPrompt,
      stream: false,
      keep_alive: '60m',
      options: {
        num_gpu: 99,
        main_gpu: 0,
        num_ctx: 2048,
        temperature: 0.2, // Baixa temperatura para correção de código precisa
        num_predict: 350
      }
    };

    const startTime = Date.now();
    const data = await queryOllama('/api/generate', 'POST', ollamaPayload);
    const durationMs = Date.now() - startTime;
    let raw = data.response || '';

    // Remove blocos markdown se existirem
    raw = raw.replace(/^```[a-z]*\n?/gim, '').replace(/\n?```$/gim, '').trim();
    const fixedCode = sanitizeForMSX(raw);

    console.log(`[DEBUGGER] Código corrigido com sucesso em ${durationMs}ms`);

    res.json({
      success: true,
      fixedCode: fixedCode,
      model: data.model,
      durationMs: durationMs
    });

  } catch (error) {
    console.error(`[DEBUGGER ERROR] Falha ao corrigir código: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Inicializacao do servidor
const server = app.listen(PORT, () => {
  console.log('====================================================');
  console.log(`  MSX - OLLAMA BRIDGE SERVER`);
  console.log(`  Servidor rodando em: http://localhost:${PORT}`);
  console.log(`  Ollama Alvo:        ${OLLAMA_HOST}`);
  console.log('====================================================');
  console.log(`Abra http://localhost:${PORT} no navegador para acessar o WebMSX integrado.`);
});

module.exports = { app, server, sanitizeForMSX, wordWrapMSX };
