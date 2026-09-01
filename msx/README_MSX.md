# Arquitetura e Execução no MSX (CHAT.BAS)

Este documento descreve como o programa MSX BASIC se comunica com o emulador e a ponte de IA (Ollama).

## 1. Funcionamento do Código MSX BASIC

```basic
10 REM ===================================================
20 REM   MSX OLLAMA AI ASSISTANT - CLIENT BASIC v1.0
30 REM   Compativeis com MSX1, MSX2, MSX2+ e MSX Turbo R
40 REM ===================================================
50 COLOR 15,4,4: SCREEN 0: WIDTH 40: CLS
60 PRINT "========================================"
70 PRINT "     MSX - OLLAMA AI ASSISTANT v1.0    "
80 PRINT "========================================"
90 PRINT "Conectado ao Bridge Node.js no Host."
100 PRINT "Digite sua pergunta (ou 'FIM' p/ sair)."
110 PRINT "----------------------------------------"
120 PRINT
130 PRINT "MSX>";
140 INPUT " "; P$
150 IF P$="" THEN GOTO 120
160 IF P$="FIM" OR P$="fim" OR P$="SAIR" OR P$="sair" THEN GOTO 300
170 PRINT
180 PRINT ">> Consultando Ollama no Host... ";
190 REM ===================================================
200 REM SINALIZACAO: LPRINT envia os dados para a porta de
210 REM impressora virtual do WebMSX. O script JS captura
220 REM o texto iniciado com o prefixo 'AI:' e despacha
230 REM para o backend Node.js (POST /api/chat).
240 REM ===================================================
250 LPRINT "AI:" + P$
260 REM O retorno sera injetado diretamente no teclado/tela
270 REM pelo WebMSX Bridge (pasteText).
280 GOTO 120
300 CLS
310 PRINT "========================================"
320 PRINT "Sessao encerrada. Ate logo!"
330 PRINT "========================================"
340 END
```

## 2. Detalhes de Baixo Nível e Portas de I/O do MSX

### Comunicação MSX -> Emulador (LPRINT):
- No hardware padrão do MSX (Z80), a instrução `LPRINT` direciona os dados para a **porta paralela de impressora Centronics**:
  - **Porta de I/O 0x90**: Registrador de Status da Impressora (Ready / Busy / Strobe).
  - **Porta de I/O 0x91**: Registrador de Dados da Impressora (8 bits).
  - **BIOS Call**: Rotina de BIOS `LPTOUT` no endereço `0x00A5` (envia caractere no registrador `A`).
- No **WebMSX**, quando o processador Z80 executa `OUT (0x91), A`, o emulador repassa o byte para o módulo `wmsx.Printer`.
- Nosso script `bridge.js` hooka esse método de saída, acumula os bytes em um buffer de linha e, ao detectar uma quebra de linha (`\r` ou `\n`) com o prefixo `AI:`, dispara a requisição HTTP para o Node.js.

### Comunicação Host -> MSX (Injeção de Resposta):
- A resposta do Ollama é processada no Node.js (Word-wrap para 38/40 colunas e conversão para ASCII puro).
- O `bridge.js` invoca a rotina nativa `WMSX.room.pasteText()`.
- O WebMSX insere a sequência de caracteres na fila de buffer de teclado do MSX (endereços `0xFBF0` a `0xFC17` na RAM do sistema MSX), fazendo com que o interpretador BASIC ou o comando `INPUT` leia a resposta como se estivesse sendo digitada diretamente pelo usuário.
