const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contatos (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(200) NOT NULL,
      empresa VARCHAR(200),
      telefone VARCHAR(20),
      email VARCHAR(200),
      origem VARCHAR(50) DEFAULT 'manual',
      status VARCHAR(50) DEFAULT 'novo',
      tags TEXT[],
      notas TEXT,
      valor DECIMAL(10,2) DEFAULT 0,
      pago BOOLEAN DEFAULT false,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversas (
      id SERIAL PRIMARY KEY,
      contato_id INTEGER REFERENCES contatos(id) ON DELETE CASCADE,
      mensagem TEXT NOT NULL,
      direcao VARCHAR(10) NOT NULL CHECK (direcao IN ('entrada', 'saida')),
      canal VARCHAR(30) DEFAULT 'whatsapp',
      lida BOOLEAN DEFAULT false,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS valor DECIMAL(10,2) DEFAULT 0;
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS pago BOOLEAN DEFAULT false;
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS nicho VARCHAR(100);
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS instagram VARCHAR(200);
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS ultima_mensagem_em TIMESTAMP;
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS ultima_msg_usuario_em TIMESTAMP;
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS followup_1h_enviado BOOLEAN DEFAULT false;
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS followup_12h_enviado BOOLEAN DEFAULT false;
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS followup_20h_enviado BOOLEAN DEFAULT false;
    ALTER TABLE contatos ADD COLUMN IF NOT EXISTS bot_pausado BOOLEAN DEFAULT false;
    CREATE TABLE IF NOT EXISTS respostas_rapidas (
      id SERIAL PRIMARY KEY,
      atalho VARCHAR(50) NOT NULL,
      mensagem TEXT,
      midia_tipo VARCHAR(20),
      midia_url TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS kanban_colunas (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(100) NOT NULL,
      cor VARCHAR(30) DEFAULT 'blue',
      posicao INTEGER DEFAULT 99,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('DB iniciado');
}
initDB().catch(console.error);

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'meu_token_verificacao';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

function corrigirTelefone(telefone) {
  let t = telefone.replace(/\D/g, '');
  if (t.length === 12 && t.startsWith('55')) {
    const ddd = t.substring(2, 4);
    const numero = t.substring(4);
    t = '55' + ddd + '9' + numero;
  }
  return t;
}

function ehMensagemDeCampanha(texto) {
  const t = texto.toLowerCase();
  return (t.includes('tenho interesse') && t.includes('mais informa')) ||
    ehCampanhaHamburguer(texto);
}

function ehCampanhaHamburguer(texto) {
  const t = texto.toLowerCase();
  return (t.includes('vi seu') && t.includes('anuncio') && t.includes('hambur')) ||
    (t.includes('anuncio') && t.includes('delivery') && t.includes('hambur')) ||
    (t.includes('anuncio') && t.includes('trafego') && t.includes('hambur'));
}

// CORRIGIDO: agora le APENAS mensagens do cliente (role: 'user'), nao do bot
function detectarNicho(historico) {
  const textoCliente = historico
    .filter(function(m) { return m.role === 'user'; })
    .map(function(m) { return m.content; })
    .join(' ')
    .toLowerCase();

  if (/hambur|burger|lanche|smash|chedda|cheeseburger/i.test(textoCliente)) return 'hamburguer';
  if (/japon|sushi|temaki|oriental|sashimi|hot roll|uramaki/i.test(textoCliente)) return 'japones';
  if (/pizza|pizzaria/i.test(textoCliente)) return 'pizza';
  if (/acai|açaí|sorvete|gelato/i.test(textoCliente)) return 'acai';
  if (/marmita|marmitex|comida caseira|fitness|low carb/i.test(textoCliente)) return 'marmita';
  if (/doce|confeitaria|bolo|brigadeiro|sobremesa/i.test(textoCliente)) return 'doces';
  if (/saudavel|saudável|natural|vegano|vegetarian/i.test(textoCliente)) return 'saudavel';
  return null;
}

function detectarInstagram(historico) {
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m.role === 'user') {
      const match = m.content.match(/@([\w.]+)/);
      if (match) return '@' + match[1];
      const matchUrl = m.content.match(/instagram\.com\/([\w.]+)/i);
      if (matchUrl) return '@' + matchUrl[1];
    }
  }
  return null;
}

function detectarNomeCliente(historico) {
  for (let i = 0; i < historico.length; i++) {
    const m = historico[i];
    if (m.role === 'user') {
      const match = m.content.match(/(?:meu nome[\s\S]*?[ee]|me chamo|sou o|sou a)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/i);
      if (match) return match[1];
    }
  }
  return null;
}

function detectarCidade(historico) {
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m.role === 'user') {
      const match = m.content.match(/(?:cidade|moro em|estou em|sou de|aqui em|meu negocio[\s\S]*?em)\s+([A-Z][a-zA-Z\s]+?)(?:[\.\,\!\?\n]|$)/i);
      if (match) return match[1].trim();
    }
  }
  return null;
}

// CORRIGIDO: detecta se o cliente REALMENTE escolheu um pacote, nao so mencionou
function detectarPacoteEscolhido(historico) {
  for (let i = historico.length - 1; i >= 0; i--) {
    const m = historico[i];
    if (m.role !== 'user') continue;
    const t = m.content.toLowerCase();
    // Frases claras de escolha
    if (/(quero|vou querer|escolho|prefiro|fica[r]? com|me manda|fechar?|topo|bora|vamos)\s+(o\s+)?(basico|básico|standard|max plus|maxplus|max)/i.test(m.content)) {
      return true;
    }
    if (/^(basico|básico|standard|max plus|maxplus|max)$/i.test(m.content.trim())) {
      return true;
    }
    if (/(o|esse|este)\s+(basico|básico|standard|max plus|maxplus|max)\s+(mesmo|entao|então|pra mim)/i.test(m.content)) {
      return true;
    }
  }
  return false;
}

// CORRIGIDO: detecta se o bot ja deu boas-vindas em alguma mensagem anterior
function botJaDeuBoasVindas(historico) {
  return historico.some(function(m) {
    if (m.role !== 'assistant') return false;
    const t = m.content.toLowerCase();
    return t.includes('bem-vindo') || t.includes('bem vindo') || t.includes('ola!') || /^ol[áa]/i.test(m.content.trim());
  });
}

function botJaPerguntouNicho(historico) {
  return historico.some(function(m) {
    if (m.role !== 'assistant') return false;
    return /qual.*nicho|trabalha com.*hambur|trabalha com.*japon|qual.*delivery|qual.*ramo|tipo de comida/i.test(m.content);
  });
}

function botJaEnviouPortfolio(historico) {
  return historico.some(function(m) {
    return m.role === 'assistant' && m.content.includes('youtube.com/shorts');
  });
}

function botJaApresentouPacotes(historico) {
  return historico.some(function(m) {
    if (m.role !== 'assistant') return false;
    return /R\$\s*69|R\$\s*89|R\$\s*197|R\$\s*297|basico.*standard.*max/i.test(m.content);
  });
}

// REESCRITO: deteccao de etapa baseada em estado real da conversa
function detectarEtapa(historico) {
  const nicho = detectarNicho(historico);

  // Etapa 6: bot ja mandou contato do Fabiano
  const botMandouFabiano = historico.some(function(m) {
    return m.role === 'assistant' && m.content.includes('5543996877898');
  });
  if (botMandouFabiano) return { etapa: 6, nicho: nicho };

  // Etapa 5: cliente respondeu pedido de dados (passou nome e/ou instagram)
  const userRespondeuDados = (detectarNomeCliente(historico) !== null) || (detectarInstagram(historico) !== null);
  if (detectarPacoteEscolhido(historico) && userRespondeuDados) {
    return { etapa: 6, nicho: nicho };
  }
  if (detectarPacoteEscolhido(historico)) {
    return { etapa: 5, nicho: nicho };
  }

  // Etapa 4: bot ja apresentou pacotes, esperando escolha
  if (botJaApresentouPacotes(historico)) {
    return { etapa: 4, nicho: nicho };
  }

  // Etapa 3: bot enviou portfolio, esperando reacao
  if (botJaEnviouPortfolio(historico) && nicho) {
    return { etapa: 3, nicho: nicho };
  }

  // Etapa 2: nicho identificado, ainda nao mandou portfolio
  if (nicho) return { etapa: 2, nicho: nicho };

  // Etapa 1: nicho ainda nao identificado
  return { etapa: 1, nicho: null };
}

function vendaNaoDesenvolveu(etapa) {
  return etapa < 6;
}

// Helpers para escolher portfolio e produto baseado no nicho
function getPortfolioPorNicho(nicho) {
  if (nicho === 'japones') {
    return [
      'https://www.youtube.com/shorts/n78ISZ6acwk',
      'https://www.youtube.com/shorts/jrbzf5kYPuY',
      'https://www.youtube.com/shorts/36uq3MaaHic'
    ];
  }
  // hamburguer e demais nichos usam portfolio do Burger Viral
  return [
    'https://www.youtube.com/shorts/Fy1022ucX0M',
    'https://www.youtube.com/shorts/qBIgF4gzOCM',
    'https://www.youtube.com/shorts/bQj0tqhX10s'
  ];
}

function getProdutoPorNicho(nicho) {
  return nicho === 'japones' ? 'Método Fome Visual' : 'Método Burger Viral';
}

function getValorBasicoPorNicho(nicho) {
  return nicho === 'japones' ? '89,90' : '69,90';
}

function getNichoLabel(nicho) {
  const labels = {
    hamburguer: 'hamburgueria',
    japones: 'comida japonesa',
    pizza: 'pizzaria',
    acai: 'açaí',
    marmita: 'marmita',
    doces: 'confeitaria',
    saudavel: 'comida saudavel'
  };
  return labels[nicho] || 'delivery';
}

// Mensagens de follow-up curtas, no tom da Vigore
function buildFollowupMsg(etapaInfo, sequencia) {
  const nicho = etapaInfo.nicho;
  const nichoLabel = getNichoLabel(nicho);
  const portfolio = getPortfolioPorNicho(nicho)[0];
  const valorBasico = getValorBasicoPorNicho(nicho);

  const msgs = {
    1: {
      1: 'Oi! So pra confirmar, qual o ramo do seu delivery?\n\nHamburguer, japonesa, pizza, outro?',
      2: 'Ei, ainda da pra conversar?\n\nQuero te mostrar como o conteudo visual aumenta venda no delivery. Qual o seu ramo?',
      3: 'Ultima passada por hoje.\n\nSe quiser saber como vender mais com video viral e foto 4K, e so me dizer o ramo.'
    },
    2: {
      1: 'Oi! Da uma olhada no que entregamos pra ' + nichoLabel + ':\n\n' + portfolio + '\n\nFaz sentido pro seu negocio?',
      2: 'Ei, so passando.\n\nNossos clientes de ' + nichoLabel + ' estao vendendo mais com video viral. Quer ver como funciona?',
      3: 'Ultima mensagem.\n\nVoce paga so depois de aprovar o material. Zero risco. Bora testar?'
    },
    3: {
      1: 'Oi! O que achou do material?\n\nDa pra sentir o desejo so de olhar. Faz sentido pra voce?',
      2: 'Ei, ainda por ai?\n\nSe travou em alguma duvida, me fala. Posso te explicar melhor.',
      3: 'Ultima chamada.\n\nAgenda fechando essa semana. Se quiser garantir, me responde.'
    },
    4: {
      1: 'Oi! Ficou alguma duvida nos pacotes?\n\nBasico R$' + valorBasico + ' / Standard R$197,90 / Max Plus R$297,90\n\nQual encaixa melhor?',
      2: 'Ei! Lembrando: voce recebe, aprova e so depois paga.\n\nZero risco. Qual pacote topa testar?',
      3: 'Ultimo aviso. Fechando agenda.\n\nMe fala o pacote e a gente comeca.'
    },
    5: {
      1: 'Oi! Falta pouco pra fechar.\n\nMe passa nome da empresa, @ do Instagram e cidade que ja damos andamento.',
      2: 'Ei! Simples: nome + @ Instagram + cidade = a gente comeca.\n\nMe manda?',
      3: 'Ultimo recado.\n\nO Fabiano ta esperando seus dados pra iniciar. Pode mandar.'
    }
  };

  const etapaKey = Math.min(etapaInfo.etapa, 5);
  const grupo = msgs[etapaKey] || msgs[1];
  return grupo[sequencia] || grupo[1];
}

// REESCRITO: prompt baseado no script real da Vigore + foco em qualificar e mandar pro Fabiano
function buildSystemPrompt(etapaInfo, ehCampanha, ehCampanhaHamb, historico) {
  const etapa = etapaInfo.etapa;
  const nicho = etapaInfo.nicho || '';
  const nichoLabel = getNichoLabel(nicho);
  const produto = getProdutoPorNicho(nicho);
  const valorBasico = getValorBasicoPorNicho(nicho);
  const portfolios = getPortfolioPorNicho(nicho);
  const linkPrincipal = portfolios[0];

  const jaDeuBoasVindas = botJaDeuBoasVindas(historico);
  const jaPerguntouNicho = botJaPerguntouNicho(historico);
  const jaEnviouPortfolio = botJaEnviouPortfolio(historico);
  const jaApresentouPacotes = botJaApresentouPacotes(historico);

  // Roteiro narrativo por nicho (do arquivo 04_ROTEIROS.txt)
  let ganchoNicho = '';
  if (nicho === 'hamburguer') {
    ganchoNicho = 'Carne na chapa. Chiado da gordura. Queijo derretendo.';
  } else if (nicho === 'japones') {
    ganchoNicho = 'Faca cortando o salmao. Brilho da peca. Montagem do sushi.';
  } else if (nicho === 'pizza') {
    ganchoNicho = 'Mussarela puxando. Borda dourada. Forno a lenha.';
  } else if (nicho === 'acai') {
    ganchoNicho = 'Acai cremoso. Cobertura caindo. Brilho da fruta.';
  } else if (nicho === 'marmita') {
    ganchoNicho = 'Comida fresca. Cores vivas. Marmita montada na hora.';
  } else if (nicho === 'doces') {
    ganchoNicho = 'Brilho do chocolate. Recheio escorrendo. Textura cremosa.';
  } else if (nicho === 'saudavel') {
    ganchoNicho = 'Cores vivas. Ingredientes frescos. Comida que ja entra pelo olho.';
  }

  // Instrucao especifica por etapa
  let instrucaoEtapa = '';

  if (etapa === 1) {
    if (jaPerguntouNicho) {
      instrucaoEtapa = 'JA PERGUNTOU NICHO ANTES.\nO cliente nao informou o ramo ainda. Reformule a pergunta de forma diferente, curta. Exemplos: "Qual o ramo do seu delivery?" ou "Trabalha com qual tipo de comida?". NAO repita a mesma frase de antes. Maximo 2 linhas.';
    } else if (!jaDeuBoasVindas) {
      instrucaoEtapa = 'PRIMEIRA MENSAGEM.\nApresente em UMA linha quem somos e pergunte o ramo. Modelo:\n"Aqui e a Vigore, criamos conteudo visual pra delivery vender mais. Voce trabalha com qual tipo de comida?"\nNao escreva mais nada.';
    } else {
      instrucaoEtapa = 'JA DEU BOAS-VINDAS, MAS NICHO AINDA NAO IDENTIFICADO.\nNAO REPITA a apresentacao. Pergunte direto o ramo. Exemplo: "Qual o ramo do seu delivery? Hambur, japonesa, pizza, outro?". Maximo 2 linhas.';
    }
  }

  else if (etapa === 2) {
    instrucaoEtapa = 'NICHO IDENTIFICADO: ' + nichoLabel.toUpperCase() + '\nMande o portfolio com IMPACTO VISUAL no inicio. Modelo:\n"' + ganchoNicho + '\\n\\n' + linkPrincipal + '\\n\\nCliente ve isso e ja pede antes de abrir o delivery. Faz sentido pra voce?"\nNao adicione mais nada. NAO repita boas-vindas. NAO pergunte o nicho de novo.';
  }

  else if (etapa === 3) {
    if (jaApresentouPacotes) {
      instrucaoEtapa = 'INTERESSE CONFIRMADO E PACOTES JA APRESENTADOS.\nPergunte qual pacote o cliente prefere. NAO repita os valores se ja foram mostrados. Maximo 2 linhas.';
    } else {
      instrucaoEtapa = 'INTERESSE CONFIRMADO. APRESENTE OS PACOTES DO ' + produto.toUpperCase() + '.\nFormato exato:\n"Temos 3 opcoes:\\n\\nBasico R$' + valorBasico + ' — 1 video + 8 fotos 4K + 30 roteiros\\nStandard R$197,90 — 3 videos + 20 fotos 4K + 40 roteiros\\nMax Plus R$297,90 — 5 videos + 35 fotos 4K + 50 roteiros\\n\\nVoce so paga depois de receber e aprovar. Qual faz mais sentido?"';
    }
  }

  else if (etapa === 4) {
    instrucaoEtapa = 'PACOTES APRESENTADOS, AGUARDANDO ESCOLHA.\nO cliente esta avaliando. Responda duvidas e reforce: "voce paga so depois de aprovar". Finalize com: "qual pacote faz mais sentido pra voce?". Maximo 4 linhas.';
  }

  else if (etapa === 5) {
    instrucaoEtapa = 'CLIENTE ESCOLHEU PACOTE. COLETAR DADOS.\nPeca: nome da empresa, @ do Instagram e cidade. Confirme o que ja recebeu, peca o que falta. Modelo:\n"Boa escolha! Pra dar andamento, me passa:\\n\\n- Nome da empresa\\n- @ do Instagram\\n- Cidade\\n\\nDepois disso o Fabiano fala com voce direto."\nMaximo 5 linhas.';
  }

  else {
    instrucaoEtapa = 'DADOS COLETADOS. PASSAR PARA O FABIANO.\nModelo:\n"Pronto! Vou te encaminhar pro Fabiano (responsavel) que ja vai cuidar do seu projeto.\\n\\nFala com ele aqui: wa.me/5543996877898\\n\\nPode mandar oi que ja sabe da sua escolha."';
  }

  return `VOCE E O ATENDENTE COMERCIAL DA VIGORE AGENCIA DIGITAL VIA WHATSAPP.

=== EMPRESA ===
Vigore Agencia Digital. Responsavel: Fabiano.
Criamos conteudo visual que aumenta desejo, retencao e vendas para delivery.
NAO vendemos videos. Vendemos DESEJO VISUAL.

=== SERVICOS ===
- Videos virais
- Fotos profissionais 4K
- Roteiros prontos

=== PRODUTOS ===
Metodo Burger Viral (hamburgueria e demais nichos): Basico R$69,90 | Standard R$197,90 | Max Plus R$297,90
Metodo Fome Visual (japonesa): Basico R$89,90 | Standard R$197,90 | Max Plus R$297,90
Pacotes incluem: video viral + fotos 4K + roteiros prontos

=== TOM DE VOZ (OBRIGATORIO) ===
- Humano, curto, direto, comercial, confiante
- Maximo 4 linhas por mensagem
- Texto simples, sem asteriscos para negrito
- Sem emojis (so se o cliente usar primeiro)
- SEMPRE finalizar com pergunta direta

=== FRASES PROIBIDAS (NUNCA USAR) ===
- "estou aqui para ajudar"
- "fico a disposicao"
- "posso ajudar com mais alguma duvida"
- "vou verificar"
- "um momento"

=== REGRAS DE VENDA ===
1. Se cliente perguntar valor: mostrar imediatamente
2. Se cliente perguntar como funciona: explicar curto
3. Se cliente mostrar interesse: pedir nome da empresa, Instagram, cidade
4. Sempre finalizar com: "faz sentido?", "qual pacote gostou mais?", "quer ver uma ideia?"
5. NUNCA oferecer agencia/servico geral. Foco no produto: video + foto + roteiro

=== OBJECOES ===
- DESCONTO: "Valor ja e o menor pra esse nivel. Voce recebe, aprova e so paga depois. Zero risco."
- PRAZO: Basico 1-2 dias | Standard 2-4 dias | Max Plus 3-5 dias
- DUVIDA / MEDO: "Voce so paga apos aprovar o material. Zero risco."
- QUER FALAR COM HUMANO: "Claro. Fala com o Fabiano: wa.me/5543996877898"

=== FUNIL ===
Etapa 1: identificar nicho
Etapa 2: enviar portfolio com gancho visual
Etapa 3: apresentar pacotes
Etapa 4: aguardar escolha do pacote
Etapa 5: coletar nome + Instagram + cidade
Etapa 6: passar para o Fabiano (wa.me/5543996877898)

=== CONTEXTO ATUAL DESTA CONVERSA ===
Etapa atual: ${etapa}
Nicho do cliente: ${nicho || 'nao identificado ainda'}
Bot ja deu boas-vindas: ${jaDeuBoasVindas ? 'SIM — NAO REPITA' : 'nao'}
Bot ja perguntou nicho: ${jaPerguntouNicho ? 'SIM — NAO REPITA A MESMA PERGUNTA' : 'nao'}
Bot ja enviou portfolio: ${jaEnviouPortfolio ? 'SIM — NAO MANDE OUTRA VEZ' : 'nao'}
Bot ja apresentou pacotes: ${jaApresentouPacotes ? 'SIM — NAO REPITA OS VALORES' : 'nao'}

=== SUA TAREFA AGORA ===
${instrucaoEtapa}
`;
}

async function enviarMensagemWhatsApp(para, mensagem, midiaUrl, midiaTipo) {
  const url = 'https://graph.facebook.com/v17.0/' + process.env.WHATSAPP_PHONE_ID + '/messages';
  let payload;
  if (midiaUrl && midiaUrl.startsWith('http')) {
    const tipo = (midiaTipo === 'video') ? 'video' : (midiaTipo === 'audio') ? 'audio' : 'image';
    payload = { messaging_product: 'whatsapp', to: para, type: tipo };
    payload[tipo] = { link: midiaUrl };
    if (mensagem) payload[tipo].caption = mensagem;
  } else {
    payload = { messaging_product: 'whatsapp', to: para, type: 'text', text: { body: mensagem || '' } };
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok) console.error('Erro WhatsApp:', JSON.stringify(data));
  return data;
}

// Sistema de follow-up dentro da janela de 24h da API oficial do WhatsApp
async function processarFollowups() {
  try {
    const agora = new Date();
    const leads = await pool.query(`
      SELECT * FROM contatos
      WHERE status IN ('novo', 'em_contato', 'qualificado')
      AND bot_pausado = false
      AND ultima_msg_usuario_em IS NOT NULL
      AND ultima_msg_usuario_em > NOW() - INTERVAL '24 hours'
    `);

    for (const contato of leads.rows) {
      const ultimaMsgUsuario = new Date(contato.ultima_msg_usuario_em);
      const diffHoras = (agora - ultimaMsgUsuario) / (1000 * 60 * 60);

      const ultimaMsgResult = await pool.query(
        'SELECT direcao FROM conversas WHERE contato_id = $1 ORDER BY criado_em DESC LIMIT 1',
        [contato.id]
      );
      const ultimaDirecao = ultimaMsgResult.rows[0] ? ultimaMsgResult.rows[0].direcao : 'entrada';
      if (ultimaDirecao !== 'saida') continue;

      const historicoRaw = await pool.query(
        'SELECT * FROM conversas WHERE contato_id = $1 ORDER BY criado_em ASC LIMIT 30',
        [contato.id]
      );
      const historico = historicoRaw.rows.map(m => ({
        role: m.direcao === 'entrada' ? 'user' : 'assistant',
        content: m.mensagem
      }));
      const etapaInfo = detectarEtapa(historico);
      if (!vendaNaoDesenvolveu(etapaInfo.etapa)) continue;

      if (diffHoras >= 1 && diffHoras < 24 && !contato.followup_1h_enviado) {
        const msg = buildFollowupMsg(etapaInfo, 1);
        await enviarMensagemWhatsApp(contato.telefone, msg);
        await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contato.id, msg, 'saida']);
        await pool.query('UPDATE contatos SET followup_1h_enviado=true, atualizado_em=NOW() WHERE id=$1', [contato.id]);
        console.log('Follow-up 1h enviado para', contato.telefone);
      }

      if (diffHoras >= 6 && diffHoras < 24 && !contato.followup_12h_enviado) {
        const msg = buildFollowupMsg(etapaInfo, 2);
        await enviarMensagemWhatsApp(contato.telefone, msg);
        await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contato.id, msg, 'saida']);
        await pool.query('UPDATE contatos SET followup_12h_enviado=true, atualizado_em=NOW() WHERE id=$1', [contato.id]);
        console.log('Follow-up 6h enviado para', contato.telefone);
      }

      if (diffHoras >= 20 && diffHoras < 24 && !contato.followup_20h_enviado) {
        const msg = buildFollowupMsg(etapaInfo, 3);
        await enviarMensagemWhatsApp(contato.telefone, msg);
        await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contato.id, msg, 'saida']);
        await pool.query("UPDATE contatos SET followup_20h_enviado=true, status='perdido', atualizado_em=NOW() WHERE id=$1", [contato.id]);
        console.log('Follow-up 20h (final 24h) enviado para', contato.telefone);
      }
    }
  } catch (err) {
    console.error('Erro processarFollowups:', err);
  }
}

setInterval(processarFollowups, 5 * 60 * 1000);

// NOVO: agrupador de mensagens rapidas
// Quando o cliente manda varias mensagens em sequencia (ex: 3 mensagens em 5 segundos),
// o bot espera um pouco e responde uma unica vez considerando todas
const mensagensPendentes = new Map(); // telefone -> { timer, mensagens: [], ultimaChegada }
const DEBOUNCE_MS = 8000; // espera 8 segundos depois da ultima mensagem

function agendarProcessamento(telefone, mensagem) {
  const agora = Date.now();

  if (mensagensPendentes.has(telefone)) {
    const pendente = mensagensPendentes.get(telefone);
    clearTimeout(pendente.timer);
    pendente.mensagens.push(mensagem);
    pendente.ultimaChegada = agora;
    pendente.timer = setTimeout(() => {
      const todas = pendente.mensagens.join('\n');
      mensagensPendentes.delete(telefone);
      processarMensagem(telefone, todas).catch(console.error);
    }, DEBOUNCE_MS);
    return;
  }

  const pendente = { mensagens: [mensagem], ultimaChegada: agora, timer: null };
  pendente.timer = setTimeout(() => {
    const todas = pendente.mensagens.join('\n');
    mensagensPendentes.delete(telefone);
    processarMensagem(telefone, todas).catch(console.error);
  }, DEBOUNCE_MS);
  mensagensPendentes.set(telefone, pendente);
}

async function processarMensagem(telefone, mensagem) {
  try {
    const telCorrigido = corrigirTelefone(telefone);
    const ehCampanha = ehMensagemDeCampanha(mensagem);
    const ehCampanhaHamb = ehCampanhaHamburguer(mensagem);

    let contato = await pool.query('SELECT * FROM contatos WHERE telefone = $1', [telCorrigido]);
    if (contato.rows.length === 0) {
      const novo = await pool.query(
        'INSERT INTO contatos (nome, telefone, origem, status) VALUES ($1,$2,$3,$4) RETURNING *',
        ['Novo Lead', telCorrigido, ehCampanha ? 'campanha' : 'whatsapp', 'novo']
      );
      contato = { rows: [novo.rows[0]] };
    }
    const contatoId = contato.rows[0].id;
    const botPausado = contato.rows[0].bot_pausado;

    await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contatoId, mensagem, 'entrada']);

    const statusAtual = contato.rows[0].status;
    if (statusAtual === 'perdido') {
      await pool.query(
        `UPDATE contatos SET ultima_msg_usuario_em=NOW(), ultima_mensagem_em=NOW(),
         followup_1h_enviado=false, followup_12h_enviado=false, followup_20h_enviado=false,
         status='em_contato', atualizado_em=NOW() WHERE id=$1`,
        [contatoId]
      );
    } else {
      await pool.query(
        'UPDATE contatos SET ultima_msg_usuario_em=NOW(), ultima_mensagem_em=NOW(), atualizado_em=NOW() WHERE id=$1',
        [contatoId]
      );
    }

    if (botPausado) {
      console.log('Bot pausado para', telefone, '- mensagem recebida mas nao respondida pelo bot');
      return;
    }

    const historicoRaw = await pool.query(
      'SELECT * FROM conversas WHERE contato_id = $1 ORDER BY criado_em ASC LIMIT 30',
      [contatoId]
    );
    const historico = historicoRaw.rows.map(m => ({
      role: m.direcao === 'entrada' ? 'user' : 'assistant',
      content: m.mensagem
    }));

    const etapaInfo = detectarEtapa(historico);

    if (etapaInfo.etapa >= 2 && contato.rows[0].status === 'novo') {
      await pool.query("UPDATE contatos SET status='em_contato', atualizado_em=NOW() WHERE id=$1", [contatoId]);
    }
    if (etapaInfo.etapa >= 5 && (contato.rows[0].status === 'novo' || contato.rows[0].status === 'em_contato')) {
      const nomeDetectado = detectarNomeCliente(historico);
      const instagramDetectado = detectarInstagram(historico);
      const nichoDetectado = etapaInfo.nicho;
      await pool.query(
        `UPDATE contatos SET status='qualificado', nicho=COALESCE($1, nicho), instagram=COALESCE($2, instagram), nome=COALESCE(NULLIF($3,''), nome), atualizado_em=NOW() WHERE id=$4`,
        [nichoDetectado, instagramDetectado, nomeDetectado, contatoId]
      );
    }

    const systemPrompt = buildSystemPrompt(etapaInfo, ehCampanha, ehCampanhaHamb, historico);
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system: systemPrompt,
        messages: historico
      })
    });
    const claudeData = await claudeResp.json();
    if (!claudeResp.ok) {
      console.error('Erro Claude:', JSON.stringify(claudeData));
      return;
    }
    const respostaBot = claudeData.content[0].text;

    await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contatoId, respostaBot, 'saida']);
    await enviarMensagemWhatsApp(telCorrigido, respostaBot);
  } catch (err) {
    console.error('Erro processarMensagem:', err);
  }
}

// Webhook verification
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === (process.env.VERIFY_TOKEN || 'meu_token_verificacao')) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// Webhook receiver — agora usa o agendador para agrupar mensagens rapidas
app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;
    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value;
        if (!value.messages) continue;
        for (const msg of value.messages) {
          if (msg.type !== 'text') continue;
          agendarProcessamento(msg.from, msg.text.body);
        }
      }
    }
  } catch (err) {
    console.error('Erro webhook:', err);
  }
});

// ===== ROTAS API =====

app.get('/api/contatos', async function(req, res) {
  try {
    const { search, status } = req.query;
    let query = 'SELECT * FROM contatos WHERE 1=1';
    const params = [];
    if (search) {
      params.push('%' + search + '%');
      query += ' AND (nome ILIKE $' + params.length + ' OR empresa ILIKE $' + params.length + ' OR telefone ILIKE $' + params.length + ')';
    }
    if (status) {
      params.push(status);
      query += ' AND status = $' + params.length;
    }
    query += ' ORDER BY atualizado_em DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contatos', async function(req, res) {
  try {
    const { nome, empresa, telefone, email, origem, status, tags, notas, valor, pago } = req.body;
    const result = await pool.query(
      'INSERT INTO contatos (nome, empresa, telefone, email, origem, status, tags, notas, valor, pago) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
      [nome, empresa, telefone, email, origem||'manual', status||'novo', tags||[], notas||'', valor||0, pago||false]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contatos/:id', async function(req, res) {
  try {
    const result = await pool.query('SELECT * FROM contatos WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/contatos/:id', async function(req, res) {
  try {
    const { nome, empresa, telefone, email, origem, status, tags, notas, valor, pago } = req.body;
    const result = await pool.query(
      'UPDATE contatos SET nome=$1, empresa=$2, telefone=$3, email=$4, origem=$5, status=$6, tags=$7, notas=$8, valor=$9, pago=$10, atualizado_em=NOW() WHERE id=$11 RETURNING *',
      [nome, empresa, telefone, email, origem, status, tags||[], notas, valor||0, pago||false, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/contatos/:id', async function(req, res) {
  try {
    await pool.query('DELETE FROM contatos WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contatos/:id/conversas', async function(req, res) {
  try {
    const result = await pool.query('SELECT * FROM conversas WHERE contato_id = $1 ORDER BY criado_em ASC', [req.params.id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contatos/:id/mensagem', async function(req, res) {
  try {
    const { mensagem, midia_url, midia_tipo } = req.body;
    const contato = await pool.query('SELECT * FROM contatos WHERE id = $1', [req.params.id]);
    if (contato.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    const textoSalvar = mensagem || (midia_url ? '[midia: ' + (midia_tipo||'imagem') + ']' : '');
    if (textoSalvar) {
      await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [req.params.id, textoSalvar, 'saida']);
    }
    await enviarMensagemWhatsApp(contato.rows[0].telefone, mensagem, midia_url, midia_tipo);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contatos/:id/conversas/marcar-lidas', async function(req, res) {
  try {
    await pool.query(
      "UPDATE conversas SET lida=true WHERE contato_id=$1 AND direcao='entrada' AND lida=false",
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload-audio', express.raw({ type: '*/*', limit: '10mb' }), async function(req, res) {
  try {
    var body = req.body;
    if (!body || !body.length) return res.status(400).json({ error: 'Nenhum audio recebido' });
    var filename = 'audio_' + crypto.randomBytes(8).toString('hex') + '.webm';
    var filepath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filepath, body);
    var baseUrl = req.protocol + '://' + req.get('host');
    res.json({ url: baseUrl + '/uploads/' + filename });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard', async function(req, res) {
  try {
    const stats = await pool.query(`SELECT COUNT(*) as total, COUNT(CASE WHEN status='novo' THEN 1 END) as novos, COUNT(CASE WHEN status='em_contato' THEN 1 END) as em_contato, COUNT(CASE WHEN status='qualificado' THEN 1 END) as qualificados, COUNT(CASE WHEN status='fechado' THEN 1 END) as fechados, COUNT(CASE WHEN status='perdido' THEN 1 END) as perdidos, COALESCE(SUM(CASE WHEN pago=true THEN valor ELSE 0 END),0) as faturamento_real, COALESCE(SUM(CASE WHEN pago=false AND status='fechado' THEN valor ELSE 0 END),0) as previsao_entrada FROM contatos`);
    res.json(stats.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/projetos', async function(req, res) {
  try {
    const result = await pool.query('SELECT p.*, c.nome as contato_nome FROM projetos p LEFT JOIN contatos c ON p.contato_id = c.id ORDER BY p.criado_em DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/projetos', async function(req, res) {
  try {
    const { contato_id, titulo, descricao, responsavel, status, progresso, prazo } = req.body;
    const result = await pool.query(
      'INSERT INTO projetos (contato_id, titulo, descricao, responsavel, status, progresso, prazo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [contato_id, titulo, descricao, responsavel, status||'iniciando', progresso||0, prazo]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/projetos/:id', async function(req, res) {
  try {
    const { titulo, descricao, responsavel, status, progresso, prazo } = req.body;
    const result = await pool.query(
      'UPDATE projetos SET titulo=$1, descricao=$2, responsavel=$3, status=$4, progresso=$5, prazo=$6, atualizado_em=NOW() WHERE id=$7 RETURNING *',
      [titulo, descricao, responsavel, status, progresso, prazo, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/contatos/:id', async function(req, res) {
  try {
    const fields = Object.keys(req.body);
    const values = Object.values(req.body);
    if (fields.length === 0) return res.status(400).json({ error: 'No fields provided' });
    const setClause = fields.map((f, i) => f + '=$' + (i+1)).join(', ');
    const result = await pool.query(
      'UPDATE contatos SET ' + setClause + ', atualizado_em=NOW() WHERE id=$' + (fields.length+1) + ' RETURNING *',
      [...values, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/respostas-rapidas', async function(req, res) {
  try {
    const result = await pool.query('SELECT * FROM respostas_rapidas ORDER BY atalho ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/respostas-rapidas', async function(req, res) {
  try {
    const { atalho, mensagem, midia_tipo, midia_url } = req.body;
    const result = await pool.query(
      'INSERT INTO respostas_rapidas (atalho, mensagem, midia_tipo, midia_url) VALUES ($1,$2,$3,$4) RETURNING *',
      [atalho, mensagem, midia_tipo||null, midia_url||null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/respostas-rapidas/:id', async function(req, res) {
  try {
    await pool.query('DELETE FROM respostas_rapidas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/kanban-colunas', async function(req, res) {
  try {
    const result = await pool.query('SELECT * FROM kanban_colunas ORDER BY posicao ASC, id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/kanban-colunas', async function(req, res) {
  try {
    const { nome, cor, posicao } = req.body;
    const result = await pool.query(
      'INSERT INTO kanban_colunas (nome, cor, posicao) VALUES ($1,$2,$3) RETURNING *',
      [nome, cor||'blue', posicao||99]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/kanban-colunas/:id', async function(req, res) {
  try {
    await pool.query('DELETE FROM kanban_colunas WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/contatos/:id/notas', async function(req, res) {
  try {
    const { notas } = req.body;
    const result = await pool.query(
      'UPDATE contatos SET notas=$1, atualizado_em=NOW() WHERE id=$2 RETURNING *',
      [notas, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bot-status', async function(req, res) {
  try {
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const token = process.env.WHATSAPP_TOKEN;
    const claudeKey = process.env.CLAUDE_API_KEY;
    let waStatus = 'unknown';
    let waError = null;
    try {
      const waResp = await fetch('https://graph.facebook.com/v18.0/' + phoneId, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const waData = await waResp.json();
      waStatus = waResp.ok ? 'ok' : 'error';
      waError = waResp.ok ? null : JSON.stringify(waData.error || waData);
    } catch(e) {
      waStatus = 'fetch_error';
      waError = e.message;
    }
    const contatosResult = await pool.query('SELECT COUNT(*) as total, COUNT(CASE WHEN bot_pausado THEN 1 END) as pausados FROM contatos');
    const convsResult = await pool.query("SELECT COUNT(*) as total FROM conversas WHERE criado_em > NOW() - INTERVAL '24 hours'");
    res.json({
      whatsapp: { status: waStatus, phone_id: phoneId ? phoneId.substring(0,8)+'...' : 'NOT SET', token_set: !!token, error: waError },
      claude: { key_set: !!claudeKey },
      db: {
        contatos: contatosResult.rows[0].total,
        bot_pausados: contatosResult.rows[0].pausados,
        conversas_24h: convsResult.rows[0].total
      }
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Servidor rodando na porta ' + PORT); });
