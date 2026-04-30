const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Conexão com PostgreSQL (Railway injeta DATABASE_URL automaticamente)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// ─── INICIALIZA BANCO DE DADOS ────────────────────────────────────────────────
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

    CREATE TABLE IF NOT EXISTS projetos (
      id SERIAL PRIMARY KEY,
      contato_id INTEGER REFERENCES contatos(id) ON DELETE SET NULL,
      titulo VARCHAR(200) NOT NULL,
      descricao TEXT,
      responsavel VARCHAR(100),
      status VARCHAR(50) DEFAULT 'iniciando',
      progresso INTEGER DEFAULT 0 CHECK (progresso >= 0 AND progresso <= 100),
      prazo DATE,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('Banco de dados inicializado.');
}

// ─── ROTAS: CONTATOS ──────────────────────────────────────────────────────────
app.get('/api/contatos', async (req, res) => {
  try {
    const { status, busca } = req.query;
    let query = 'SELECT * FROM contatos';
    const params = [];
    const conditions = [];

    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }
    if (busca) {
      params.push(`%${busca}%`);
      conditions.push(`(nome ILIKE $${params.length} OR empresa ILIKE $${params.length})`);
    }
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY criado_em DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/contatos', async (req, res) => {
  try {
    const { nome, empresa, telefone, email, origem, status, notas } = req.body;
    const result = await pool.query(
      `INSERT INTO contatos (nome, empresa, telefone, email, origem, status, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [nome, empresa, telefone, email, origem || 'manual', status || 'novo', notas]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/contatos/:id', async (req, res) => {
  try {
    const { nome, empresa, telefone, email, status, notas } = req.body;
    const result = await pool.query(
      `UPDATE contatos SET nome=$1, empresa=$2, telefone=$3, email=$4,
       status=$5, notas=$6, atualizado_em=NOW() WHERE id=$7 RETURNING *`,
      [nome, empresa, telefone, email, status, notas, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.delete('/api/contatos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM contatos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── ROTAS: CONVERSAS ─────────────────────────────────────────────────────────
app.get('/api/conversas/:contato_id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM conversas WHERE contato_id=$1 ORDER BY criado_em ASC',
      [req.params.contato_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/conversas', async (req, res) => {
  try {
    const { contato_id, mensagem, direcao, canal } = req.body;
    const result = await pool.query(
      `INSERT INTO conversas (contato_id, mensagem, direcao, canal)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [contato_id, mensagem, direcao || 'entrada', canal || 'whatsapp']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── ROTAS: PROJETOS ──────────────────────────────────────────────────────────
app.get('/api/projetos', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, c.nome as contato_nome FROM projetos p
       LEFT JOIN contatos c ON p.contato_id = c.id
       ORDER BY p.criado_em DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/api/projetos', async (req, res) => {
  try {
    const { contato_id, titulo, descricao, responsavel, status, progresso, prazo } = req.body;
    const result = await pool.query(
      `INSERT INTO projetos (contato_id, titulo, descricao, responsavel, status, progresso, prazo)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [contato_id, titulo, descricao, responsavel, status || 'iniciando', progresso || 0, prazo]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.put('/api/projetos/:id', async (req, res) => {
  try {
    const { titulo, descricao, responsavel, status, progresso, prazo } = req.body;
    const result = await pool.query(
      `UPDATE projetos SET titulo=$1, descricao=$2, responsavel=$3,
       status=$4, progresso=$5, prazo=$6, atualizado_em=NOW() WHERE id=$7 RETURNING *`,
      [titulo, descricao, responsavel, status, progresso, prazo, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── ROTA: DASHBOARD ─────────────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const [leads, clientes, conversao, projetos, funil] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM contatos WHERE status != 'cliente' AND status != 'perdido'`),
      pool.query(`SELECT COUNT(*) FROM contatos WHERE status = 'cliente'`),
      pool.query(`SELECT
        ROUND(COUNT(*) FILTER (WHERE status='cliente') * 100.0 / NULLIF(COUNT(*),0), 0) as taxa
        FROM contatos`),
      pool.query(`SELECT COUNT(*) FROM projetos WHERE status != 'concluido'`),
      pool.query(`SELECT status, COUNT(*) as total FROM contatos GROUP BY status ORDER BY total DESC`)
    ]);
    res.json({
      leads: parseInt(leads.rows[0].count),
      clientes: parseInt(clientes.rows[0].count),
      conversao: parseInt(conversao.rows[0].taxa) || 0,
      projetos_ativos: parseInt(projetos.rows[0].count),
      funil: funil.rows
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── WEBHOOK DO WHATSAPP ──────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'meu_token_secreto';
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    const contact = change?.value?.contacts?.[0];

    if (!message || message.type !== 'text') return res.sendStatus(200);

    const telefone = message.from;
    const texto = message.text.body;
    const nomeWhatsapp = contact?.profile?.name || 'Desconhecido';

    // Busca ou cria o contato automaticamente
    let contato = await pool.query('SELECT * FROM contatos WHERE telefone=$1', [telefone]);
    if (contato.rows.length === 0) {
      contato = await pool.query(
        `INSERT INTO contatos (nome, telefone, origem, status)
         VALUES ($1,$2,'whatsapp','novo') RETURNING *`,
        [nomeWhatsapp, telefone]
      );
    }
    const contatoId = contato.rows[0].id;

    // Salva a mensagem
    await pool.query(
      `INSERT INTO conversas (contato_id, mensagem, direcao, canal, lida)
       VALUES ($1,$2,'entrada','whatsapp', false)`,
      [contatoId, texto]
    );

    // Chama o Claude para gerar resposta
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `Você é o assistente virtual de uma agência de marketing. 
Seja simpático, profissional e objetivo.
Quando o cliente perguntar sobre serviços, mencione: gestão de redes sociais, tráfego pago, SEO e criação de conteúdo.
Sempre finalize convidando o cliente a conversar com um especialista da equipe.`,
        messages: [{ role: 'user', content: texto }]
      })
    });

    const claudeData = await claudeRes.json();
    const resposta = claudeData.content?.[0]?.text;

    if (resposta) {
      // Salva resposta do Claude no histórico
      await pool.query(
        `INSERT INTO conversas (contato_id, mensagem, direcao, canal)
         VALUES ($1,$2,'saida','whatsapp')`,
        [contatoId, resposta]
      );

      // Envia pelo WhatsApp
      await fetch(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: telefone,
          text: { body: resposta }
        })
      });
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.sendStatus(500);
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`CRM rodando na porta ${PORT}`));
});
