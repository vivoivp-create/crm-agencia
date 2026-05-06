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

function detectarNicho(historico) {
  const texto = historico.map(function(m) { return m.content; }).join(' ').toLowerCase();
  if (texto.includes('hambur') || texto.includes('burger') || texto.includes('lanche') || texto.includes('fast food')) {
    return 'hamburguer';
  }
  if (texto.includes('japones') || texto.includes('sushi') || texto.includes('temaki') || texto.includes('oriental')) {
    return 'japones';
  }
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

// Detecta em qual etapa do funil a conversa esta
function detectarEtapa(historico) {
  const texto = historico.map(function(m) { return m.content; }).join(' ').toLowerCase();
  const nicho = detectarNicho(historico);

  // Etapa 6: lead enviado para Fabiano
  const botMandouFabiano = historico.some(function(m) {
    return m.role === 'assistant' && m.content.includes('wa.me/5543996877898');
  });
  if (botMandouFabiano) return { etapa: 6, nicho: nicho };

  // Etapa 5: bot pediu dados (nome/instagram) mas ainda nao recebeu
  const botPediuDados = historico.some(function(m) {
    return m.role === 'assistant' && /nome|instagram|whatsapp|cidade/i.test(m.content) && /me passa|qual.*seu|pode me informar/i.test(m.content);
  });
  const userRespondeuDados = historico.some(function(m) {
    return m.role === 'user' && (/@[\w.]+/.test(m.content) || /meu nome|me chamo|sou o|sou a/i.test(m.content));
  });
  if (botPediuDados && userRespondeuDados) return { etapa: 6, nicho: nicho };
  if (botPediuDados) return { etapa: 5, nicho: nicho };

  // Etapa 4: cliente escolheu um pacote
  const clienteEscolheuPacote = historico.some(function(m) {
    return m.role === 'user' && /basico|standard|max plus|basico|padrao/i.test(m.content);
  });
  if (clienteEscolheuPacote) return { etapa: 4, nicho: nicho };

  // Etapa 3: bot enviou portfolio, aguardando interesse
  const botEnviouPortfolio = historico.some(function(m) {
    return m.role === 'assistant' && m.content.includes('youtube.com');
  });
  if (botEnviouPortfolio && nicho) return { etapa: 3, nicho: nicho };

  // Etapa 2: nicho identificado, portfolio nao enviado ainda
  if (nicho) return { etapa: 2, nicho: nicho };

  // Etapa 1: inicio, nicho nao identificado
  return { etapa: 1, nicho: null };
}

function vendaNaoDesenvolveu(etapa) {
  return etapa < 6;
}

// Mensagens de follow-up por etapa e sequencia
// Segue o tom da Vigore: direto, confiante, sem frescura
function buildFollowupMsg(etapaInfo, sequencia) {
  const nicho = etapaInfo.nicho;
  const nichoLabel = nicho === 'hamburguer' ? 'hamburguer' : (nicho === 'japones' ? 'japones' : 'delivery');
  const produto = nicho === 'japones' ? 'Fome Visual' : 'Burger Viral';
  const portfolio = nicho === 'japones' ? 'https://www.youtube.com/shorts/36uq3MaaHic' : 'https://www.youtube.com/shorts/Fy1022ucX0M';

  const msgs = {
    1: {
      1: `Oi! Voce viu nosso conteudo de ${nichoLabel}?\n\n${portfolio}\n\nIsso e o que entregamos. Faz sentido pro seu negocio?`,
      2: `Ei, so passando rapidinho.\n\nNossos clientes de ${nichoLabel} estao vendendo mais com o ${produto}. Quer ver como funciona?`,
      3: `Ultima mensagem por hoje.\n\nSe quiser turbinar o visual do seu ${nichoLabel} e vender mais, e so responder. Zero risco, voce paga so depois de aprovar.`
    },
    2: {
      1: `Oi! Vi que nao chegou a ver o portfolio.\n\n${portfolio}\n\nDa pra sentir o desejo so de olhar. Qual pacote faz mais sentido pra voce?`,
      2: `Ei! Ainda por aqui?\n\nVoce so paga depois de ver e aprovar o material. Zero risco. O que travou?`,
      3: `Ultima chamada!\n\nAgenda fechando essa semana. Se quiser garantir, me responde agora.`
    },
    3: {
      1: `Oi! Ficou com duvida sobre os pacotes?\n\nBasico R$${nicho === 'japones' ? '89,90' : '69,90'} | Standard R$197,90 | Max Plus R$297,90\n\nQual encaixa melhor no seu momento?`,
      2: `Ei! Lembrando que voce recebe, aprova e so entao paga.\n\nZero risco. Qual pacote voce toparia testar?`,
      3: `Ultimo aviso! Fechando agenda essa semana.\n\nMe fala o pacote e a gente ja comeca. Voce paga so depois de aprovar.`
    },
    4: {
      1: `Oi! Falta pouco pra fechar.\n\nSo me passa seu nome e o @ do instagram que a gente da andamento!`,
      2: `Ei! Simples assim: nome + @ do instagram = a gente comeca.\n\nMe manda ai?`,
      3: `Ultimo recado!\n\nO Fabiano ta esperando seus dados pra comecar. Nome e @ do instagram, pode mandar!`
    }
  };

  const etapaKey = etapaInfo.etapa <= 4 ? etapaInfo.etapa : 4;
  const grupo = msgs[etapaKey] || msgs[1];
  return grupo[sequencia] || grupo[1];
}

function buildSystemPrompt(etapaInfo, ehCampanha, ehCampanhaHamb) {
  const etapa = etapaInfo.etapa;
  const nicho = etapaInfo.nicho || '';
  const ehHamburguer = nicho === 'hamburguer' || ehCampanhaHamb;
  const ehJapones = nicho === 'japones';
  const nichoLabel = ehHamburguer ? 'hamburguer' : (ehJapones ? 'japonesa' : 'restaurante');
  const pacotesHamb = 'BASICO R$69,90: 1 video + 8 fotos 4K + 30 roteiros | STANDARD R$197,90: 3 videos + 20 fotos 4K + 40 roteiros | MAX PLUS R$297,90: 5 videos + 35 fotos 4K + 50 roteiros. Cliente paga SOMENTE apos ver e aprovar o material.';
  const pacotesJap = 'BASICO R$89,90: 1 video + 8 fotos 4K + 30 roteiros | STANDARD R$197,90: 3 videos + 20 fotos 4K + 40 roteiros | MAX PLUS R$297,90: 5 videos + 35 fotos 4K + 50 roteiros. Cliente paga SOMENTE apos ver e aprovar o material.';
  const pacotes = ehJapones ? pacotesJap : pacotesHamb;
  const portfolioHamb = 'https://www.youtube.com/shorts/Fy1022ucX0M e https://www.youtube.com/shorts/qBIgF4gzOCM e https://www.youtube.com/shorts/bQj0tqhX10s';
  const portfolioJap = 'https://www.youtube.com/shorts/n78ISZ6acwk e https://www.youtube.com/shorts/jrbzf5kYPuY';
  const portfolio = ehJapones ? portfolioJap : portfolioHamb;
  return `Voce e o assistente comercial da Vigore Agencia Digital. Responsavel: Fabiano.\nMISSAO: criar conteudos visuais que aumentam desejo, retencao e vendas para delivery.\nPOSICIONAMENTO: Nao vendemos videos. Vendemos desejo visual.\n\nTOM: humano, curto, direto, confiante. Max 4 linhas por mensagem.\nNUNCA use: 'vou verificar', 'estou aqui para ajudar', 'fico a disposicao', 'posso ajudar com mais alguma duvida', 'um momento'.\nSEMPRE finalizar com pergunta. NUNCA listar servicos genericos (SEO, trafego pago) antes de vender os videos.\n\nPRODUTOS:\n- Metodo Burger Viral (hamburguerias) | portfolio: ${portfolioHamb}\n- Metodo Fome Visual (japonesa) | portfolio: ${portfolioJap}\n\nPACOTES (${nichoLabel}): ${pacotes}\n\nFLUXO OBRIGATORIO:\n1. ABERTURA: Se etapa=1 (ainda nao sabe o nicho), pergunte APENAS: 'Voce trabalha com hamburguer, comida japonesa ou outro nicho?'. NAO mande boas-vindas repetidas.\n2. APOS NICHO hamburguer: mande ${portfolioHamb.split(' e ')[0]} com 'Carne na chapa. Queijo derretendo. O cliente ve isso e ja ta pedindo. Faz sentido?'\n3. APOS NICHO japonesa: mande ${portfolioJap.split(' e ')[0]} com 'Faca cortando salmao. Brilho da peca. O desejo ja venceu antes da primeira mordida. Faz sentido?'\n4. QUANDO PEDIR VALOR: mostre IMEDIATAMENTE os pacotes, sem pedir mais info antes.\n5. COMO FUNCIONA: 'Voce escolhe o pacote, a gente cria, voce recebe, aprova e so entao paga.'\n6. FECHAMENTO: pedir nome, Instagram, WhatsApp e cidade.\n\nOBJECOES:\n- DESCONTO: 'Valor ja e o menor pra esse nivel. Voce recebe, aprova e so paga. Zero risco. O que travou?' - se insistir: oferecer Basico.\n- PRAZO: Basico 1-2 dias, Standard 2-4 dias, Max Plus 3-5 dias.\n- PEDIDO HUMANO/ATENDENTE: 'Claro! Fala com o Fabiano: wa.me/5543996877898' - NUNCA resistir.\n- OUTROS NICHOS (pizzaria etc): atender normalmente com pacotes do Burger Viral.\n\nREGRA CRITICA: Se o usuario JA respondeu o nicho (etapa >= 2), NAO pergunte o nicho de novo. Continue o fluxo na etapa correta.\n\nEtapa atual: ${etapa} | Nicho: ${nichoLabel || 'nao identificado'}`;
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
// A API so permite mensagens fora de template dentro de 24h da ultima mensagem do USUARIO
// Follow-up 1: 1h sem resposta do usuario
// Follow-up 2: 6h sem resposta do usuario
// Follow-up 3: 20h sem resposta do usuario (ultimo antes de fechar janela de 24h)
async function processarFollowups() {
  try {
    const agora = new Date();
    // Busca apenas leads ativos onde a ultima mensagem DO USUARIO foi < 24h atras
    // Isso garante que ainda estamos dentro da janela de 24h da API
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

      // Nao envia follow-up se a ultima mensagem foi do bot (evita spam)
      // Verifica se a ultima mensagem na conversa foi do bot
      const ultimaMsgResult = await pool.query(
        'SELECT direcao FROM conversas WHERE contato_id = $1 ORDER BY criado_em DESC LIMIT 1',
        [contato.id]
      );
      const ultimaDirecao = ultimaMsgResult.rows[0] ? ultimaMsgResult.rows[0].direcao : 'entrada';
      // Só envia follow-up se a ultima mensagem ja foi do bot (ou seja, usuario nao respondeu)
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

      // Follow-up 1h (primeira tentativa)
      if (diffHoras >= 1 && diffHoras < 24 && !contato.followup_1h_enviado) {
        const msg = buildFollowupMsg(etapaInfo, 1);
        await enviarMensagemWhatsApp(contato.telefone, msg);
        await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contato.id, msg, 'saida']);
        await pool.query('UPDATE contatos SET followup_1h_enviado=true, atualizado_em=NOW() WHERE id=$1', [contato.id]);
        console.log('Follow-up 1h enviado para', contato.telefone);
      }

      // Follow-up 6h (segunda tentativa)
      if (diffHoras >= 6 && diffHoras < 24 && !contato.followup_12h_enviado) {
        const msg = buildFollowupMsg(etapaInfo, 2);
        await enviarMensagemWhatsApp(contato.telefone, msg);
        await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contato.id, msg, 'saida']);
        await pool.query('UPDATE contatos SET followup_12h_enviado=true, atualizado_em=NOW() WHERE id=$1', [contato.id]);
        console.log('Follow-up 6h enviado para', contato.telefone);
      }

      // Follow-up 20h (ultima tentativa antes de fechar janela 24h)
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

// Verifica follow-ups a cada 5 minutos
setInterval(processarFollowups, 5 * 60 * 1000);

async function processarMensagem(telefone, mensagem) {
  try {
    const telCorrigido = corrigirTelefone(telefone);
    const ehCampanha = ehMensagemDeCampanha(mensagem);
    const ehCampanhaHamb = ehCampanhaHamburguer(mensagem);

    // Busca ou cria contato
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

    // Salva a mensagem de entrada ANTES de buscar historico
    await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contatoId, mensagem, 'entrada']);

    // Atualiza ultima_msg_usuario_em (APENAS quando usuario manda mensagem)
    // Isso e crucial para o controle da janela de 24h do follow-up
    // NAO resetamos os flags de follow-up aqui - eles so resetam quando o usuario responde
    // após ter sido marcado como perdido
    const statusAtual = contato.rows[0].status;
    if (statusAtual === 'perdido') {
      // Usuario voltou! Reseta tudo e começa novo ciclo
      await pool.query(
        `UPDATE contatos SET ultima_msg_usuario_em=NOW(), ultima_mensagem_em=NOW(),
         followup_1h_enviado=false, followup_12h_enviado=false, followup_20h_enviado=false,
         status='em_contato', atualizado_em=NOW() WHERE id=$1`,
        [contatoId]
      );
    } else {
      // Atualiza timestamp da ultima mensagem do usuario
      await pool.query(
        'UPDATE contatos SET ultima_msg_usuario_em=NOW(), ultima_mensagem_em=NOW(), atualizado_em=NOW() WHERE id=$1',
        [contatoId]
      );
    }

    // Se bot pausado, nao responde automaticamente
    if (botPausado) {
      console.log('Bot pausado para', telefone, '- mensagem recebida mas nao respondida pelo bot');
      return;
    }

    // Busca historico APOS salvar a mensagem de entrada
    const historicoRaw = await pool.query(
      'SELECT * FROM conversas WHERE contato_id = $1 ORDER BY criado_em ASC LIMIT 30',
      [contatoId]
    );
    const historico = historicoRaw.rows.map(m => ({
      role: m.direcao === 'entrada' ? 'user' : 'assistant',
      content: m.mensagem
    }));

    const etapaInfo = detectarEtapa(historico);

    // Atualiza status do contato baseado na etapa
    if (etapaInfo.etapa >= 2 && contato.rows[0].status === 'novo') {
      await pool.query("UPDATE contatos SET status='em_contato', atualizado_em=NOW() WHERE id=$1", [contatoId]);
    }
    if (etapaInfo.etapa >= 4 && (contato.rows[0].status === 'novo' || contato.rows[0].status === 'em_contato')) {
      const nomeDetectado = detectarNomeCliente(historico);
      const instagramDetectado = detectarInstagram(historico);
      const nichoDetectado = etapaInfo.nicho;
      await pool.query(
        `UPDATE contatos SET status='qualificado', nicho=COALESCE($1, nicho), instagram=COALESCE($2, instagram), nome=COALESCE(NULLIF($3,''), nome), atualizado_em=NOW() WHERE id=$4`,
        [nichoDetectado, instagramDetectado, nomeDetectado, contatoId]
      );
    }

    // Chama Claude com historico completo e etapa correta
    const systemPrompt = buildSystemPrompt(etapaInfo, ehCampanha, ehCampanhaHamb);
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

    // Salva resposta e envia
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

// Webhook receiver
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
          await processarMensagem(msg.from, msg.text.body);
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
