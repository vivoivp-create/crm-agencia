const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  return t.includes('tenho interesse') && t.includes('mais informa');
}

function detectarNicho(historico) {
  const texto = historico.map(function(m) { return m.content; }).join(' ').toLowerCase();
  if (texto.includes('hambur') || texto.includes('burger') || texto.includes('lanche') || texto.includes('fast food')) {
    return 'hamburguer';
  }
  if (texto.includes('japones') || texto.includes('japones') || texto.includes('sushi') || texto.includes('temaki') || texto.includes('oriental')) {
    return 'japones';
  }
  return null;
}

function detectarEtapa(historico) {
  const texto = historico.map(function(m) { return m.content; }).join(' ').toLowerCase();
  const nicho = detectarNicho(historico);

  if (texto.includes('fabiano') && texto.includes('entrar em contato')) {
    return { etapa: 6, nicho: nicho };
  }

  const botPediuNome = historico.some(function(m) { return m.role === 'assistant' && /qual.*seu nome|como.*se chama|nome.*empresa/i.test(m.content); });
  const temNome = historico.some(function(m) { return m.role === 'user' && /meu nome|me chamo|sou o |sou a /i.test(m.content); });

  if (botPediuNome && temNome) { return { etapa: 6, nicho: nicho }; }
  if (botPediuNome) { return { etapa: 5, nicho: nicho }; }

  if (texto.includes('basico') || texto.includes('standard') || texto.includes('max plus')) {
    return { etapa: 4, nicho: nicho };
  }

  const botEnviouPortfolio = historico.some(function(m) { return m.role === 'assistant' && m.content.includes('youtube.com'); });
  const botFezPergunta = historico.some(function(m) { return m.role === 'assistant' && (m.content.includes('fez sentido') || m.content.includes('achou')); });

  if (botEnviouPortfolio && botFezPergunta) { return { etapa: 3, nicho: nicho }; }
  if (nicho) {
    if (botEnviouPortfolio) { return { etapa: 3, nicho: nicho }; }
    return { etapa: 2, nicho: nicho };
  }
  return { etapa: 1, nicho: null };
}

function buildSystemPrompt(etapaInfo, ehCampanha) {
  var etapa = etapaInfo.etapa;
  var nicho = etapaInfo.nicho;

  var videosHamburguer = 'https://www.youtube.com/shorts/qv-QmvltN5k\nhttps://www.youtube.com/shorts/NuV23DgBTnk\nhttps://www.youtube.com/shorts/Z58kSeUO8k4';
  var videosJapones = 'https://www.youtube.com/shorts/36uq3MaaHic\nhttps://www.youtube.com/shorts/jrbzf5kYPuY\nhttps://www.youtube.com/shorts/n78ISZ6acwk';
  var planoHamburguer = 'Metodo Burger Viral:\n- Basico: R$69,90/mes\n- Standard: R$197,90/mes\n- Max Plus: R$297,90/mes';
  var planoJapones = 'Metodo Fome Visual:\n- Basico: R$89,90/mes\n- Standard: R$197,90/mes\n- Max Plus: R$297,90/mes';

  var instrucaoEtapa = '';

  if (etapa === 1) {
    if (ehCampanha) {
      instrucaoEtapa = 'INSTRUCAO ETAPA 1 (CAMPANHA): Cliente veio de campanha e ja tem interesse. Va direto ao ponto: pergunte APENAS qual tipo de negocio: hamburguer/fast food, restaurante japones, ou outro? Sem introducao longa.';
    } else {
      instrucaoEtapa = 'INSTRUCAO ETAPA 1: Descubra o nicho do negocio. Pergunte de forma amigavel e curta qual o tipo de negocio: hamburguer/fast food, restaurante japones, ou outro tipo.';
    }
  } else if (etapa === 2) {
    var videos = nicho === 'hamburguer' ? videosHamburguer : (nicho === 'japones' ? videosJapones : null);
    var metodo = nicho === 'hamburguer' ? 'Metodo Burger Viral' : (nicho === 'japones' ? 'Metodo Fome Visual' : null);
    if (videos) {
      instrucaoEtapa = 'INSTRUCAO ETAPA 2: Nicho e ' + nicho + '. Envie agora os 3 links do portfolio do ' + metodo + '. Copie e envie exatamente:\n' + videos + '\nDepois pergunte: fez sentido? O que achou?';
    } else {
      instrucaoEtapa = 'INSTRUCAO ETAPA 2: Outro nicho. Mostre o canal: https://www.youtube.com/@Vigoredigital e pergunte o que achou.';
    }
  } else if (etapa === 3) {
    var planos = nicho === 'hamburguer' ? planoHamburguer : (nicho === 'japones' ? planoJapones : 'nossos planos de marketing digital');
    instrucaoEtapa = 'INSTRUCAO ETAPA 3: Portfolio ja enviado. Gere desejo e apresente os planos:\n' + planos + '\nSempre diga: Voce so paga apos ver o material pronto. Pergunte qual plano faz mais sentido.';
  } else if (etapa === 4) {
    instrucaoEtapa = 'INSTRUCAO ETAPA 4: Planos apresentados. Capture o nome: pergunte qual e o nome completo e o nome do estabelecimento.';
  } else if (etapa === 5) {
    instrucaoEtapa = 'INSTRUCAO ETAPA 5: Nome capturado. Informe que o Fabiano entrara em contato em breve para fechar os detalhes. Finalize de forma calorosa.';
  } else {
    instrucaoEtapa = 'INSTRUCAO ETAPA 6: Conversa encerrada. Se cliente mandar mensagem, seja cordial e diga que o Fabiano ja tem as informacoes e entrara em contato.';
  }

  return 'Voce e o assistente virtual da Vigore Agencia Digital, especializada em marketing digital para restaurantes. Voce se comunica pelo WhatsApp.\n\nREGRAS ABSOLUTAS - NUNCA VIOLE:\n1. NUNCA use markdown: proibido usar #, *, **, _, nem listas com simbolos. Texto puro e simples apenas.\n2. NUNCA repita perguntas ja respondidas no historico.\n3. NUNCA volte a perguntar o nicho se ja foi identificado.\n4. NUNCA pergunte o nome antes da etapa 4.\n5. SEMPRE leia todo o historico antes de responder.\n6. Respostas curtas e diretas, linguagem informal e amigavel.\n7. Use emojis com moderacao.\n\n' + instrucaoEtapa;
}

async function enviarMensagemWhatsApp(para, mensagem) {
  const url = 'https://graph.facebook.com/v17.0/' + process.env.WHATSAPP_PHONE_ID + '/messages';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.WHATSAPP_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: para, type: 'text', text: { body: mensagem } })
  });
  const data = await resp.json();
  if (!resp.ok) console.error('Erro WhatsApp:', JSON.stringify(data));
  return data;
}

async function processarMensagem(telefone, mensagem) {
  try {
    const telCorrigido = corrigirTelefone(telefone);
    const ehCampanha = ehMensagemDeCampanha(mensagem);

    let contato = await pool.query('SELECT * FROM contatos WHERE telefone = $1', [telCorrigido]);
    if (contato.rows.length === 0) {
      const novo = await pool.query(
        'INSERT INTO contatos (nome, telefone, origem, status) VALUES ($1,$2,$3,$4) RETURNING *',
        ['Novo Lead', telCorrigido, ehCampanha ? 'campanha' : 'whatsapp', 'novo']
      );
      contato = { rows: [novo.rows[0]] };
    }

    const contatoId = contato.rows[0].id;

    await pool.query(
      'INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)',
      [contatoId, mensagem, 'entrada']
    );

    const historicoRaw = await pool.query(
      'SELECT * FROM conversas WHERE contato_id = $1 ORDER BY criado_em ASC LIMIT 30',
      [contatoId]
    );

    const historico = historicoRaw.rows.map(function(m) {
      return { role: m.direcao === 'entrada' ? 'user' : 'assistant', content: m.mensagem };
    });

    const etapaInfo = detectarEtapa(historico);

    if (etapaInfo.etapa >= 2 && contato.rows[0].status === 'novo') {
      await pool.query('UPDATE contatos SET status=$1, atualizado_em=NOW() WHERE id=$2', ['em_contato', contatoId]);
    }
    if (etapaInfo.etapa >= 4 && (contato.rows[0].status === 'novo' || contato.rows[0].status === 'em_contato')) {
      await pool.query('UPDATE contatos SET status=$1, atualizado_em=NOW() WHERE id=$2', ['qualificado', contatoId]);
    }

    const systemPrompt = buildSystemPrompt(etapaInfo, ehCampanha);

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
    if (!claudeResp.ok) { console.error('Erro Claude:', JSON.stringify(claudeData)); return; }

    const respostaBot = claudeData.content[0].text;

    await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [contatoId, respostaBot, 'saida']);
    await enviarMensagemWhatsApp(telCorrigido, respostaBot);

  } catch (err) {
    console.error('Erro processarMensagem:', err);
  }
}

app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === (process.env.VERIFY_TOKEN || 'meu_token_verificacao')) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

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
  } catch (err) { console.error('Erro webhook:', err); }
});

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
    const { mensagem } = req.body;
    const contato = await pool.query('SELECT * FROM contatos WHERE id = $1', [req.params.id]);
    if (contato.rows.length === 0) return res.status(404).json({ error: 'Nao encontrado' });
    await pool.query('INSERT INTO conversas (contato_id, mensagem, direcao) VALUES ($1,$2,$3)', [req.params.id, mensagem, 'saida']);
    await enviarMensagemWhatsApp(contato.rows[0].telefone, mensagem);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Servidor rodando na porta ' + PORT); });
