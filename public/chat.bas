5 CLEAR 4000
10 REM ===================================================
20 REM   MSX OLLAMA AI ASSISTANT - CLIENT BASIC v1.2
30 REM   Compativeis com MSX1, MSX2, MSX2+ e MSX Turbo R
40 REM ===================================================
50 COLOR 15,4,4: SCREEN 0: WIDTH 40: CLS
60 PRINT "========================================"
70 PRINT "     MSX - OLLAMA AI ASSISTANT v1.2    "
80 PRINT "========================================"
90 PRINT "Bridge Ativo: Node.js & Ollama Local"
100 PRINT "Digite sua pergunta (ou 'FIM' p/ sair)."
110 PRINT "----------------------------------------"
120 P$="": R$=""
130 PRINT
140 LINE INPUT "MSX> "; P$
150 IF P$="" THEN GOTO 120
160 IF P$="FIM" OR P$="fim" OR P$="SAIR" OR P$="sair" THEN GOTO 300
170 PRINT
180 PRINT ">> Consultando Ollama no Host... "
190 REM ===================================================
200 REM SINALIZACAO: LPRINT envia o prompt para o Bridge.
210 REM O Bridge consulta o Ollama e injeta a resposta
220 REM no LINE INPUT abaixo.
230 REM ===================================================
240 LPRINT "AI:" + P$
250 LINE INPUT ""; R$
260 PRINT
270 PRINT "RESPOSTA DA IA:"
280 PRINT R$
290 PRINT "----------------------------------------"
300 GOTO 120
310 CLS
320 PRINT "========================================"
330 PRINT "Sessao encerrada. Ate logo!"
340 PRINT "========================================"
350 END
