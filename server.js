const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Criar tabela leads se não existir
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
      telefone VARCHAR(20) UNIQUE NOT NULL,
      nome VARCHAR(255),
      nicho VARCHAR(50),
      status VARCHAR(30) DEFAULT 'frio',
      orcamento DECIMAL(10,2) DEFAULT 0,
      adiantamento DECIMAL(10,2) DEFAULT 0,
      pago DECIMAL(10,2) DEFAULT 0,
      checklist JSONB DEFAULT '{"orcamento":false,"adiantamento":false,"pago":false,"aguardando_materiais":false,"trabalho_pronto":false}',
      ultima_mensagem TEXT,
      historico_resumo TEXT,
      reaquecimento_count INTEGER DEFAULT 0,
      ultimo_contato TIMESTAMP DEFAULT NOW(),
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Banco de dados inicializado');
}

// POST /api/leads — recebe dados do n8n
app.post('/api/leads', async (req, res) => {
  try {
    const {
      telefone, nome, nicho, status,
      ultima_mensagem, historico_resumo,
      orcamento, adiantamento, pago
    } = req.body;

    if (!telefone) return res.status(400).json({ error: 'telefone obrigatorio' });

    const result = await pool.query(`
      INSERT INTO leads (telefone, nome, nicho, status, ultima_mensagem, historico_resumo, orcamento, adiantamento, pago, ultimo_contato, atualizado_em)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
      ON CONFLICT (telefone) DO UPDATE SET
        nome = COALESCE(EXCLUDED.nome, leads.nome),
        nicho = COALESCE(EXCLUDED.nicho, leads.nicho),
        status = COALESCE(EXCLUDED.status, leads.status),
        ultima_mensagem = COALESCE(EXCLUDED.ultima_mensagem, leads.ultima_mensagem),
        historico_resumo = COALESCE(EXCLUDED.historico_resumo, leads.historico_resumo),
        orcamento = CASE WHEN EXCLUDED.orcamento > 0 THEN EXCLUDED.orcamento ELSE leads.orcamento END,
        adiantamento = CASE WHEN EXCLUDED.adiantamento > 0 THEN EXCLUDED.adiantamento ELSE leads.adiantamento END,
        pago = CASE WHEN EXCLUDED.pago > 0 THEN EXCLUDED.pago ELSE leads.pago END,
        ultimo_contato = NOW(),
        atualizado_em = NOW(),
        reaquecimento_count = 0
      RETURNING *
    `, [
      telefone, nome || null, nicho || null, status || 'frio',
      ultima_mensagem || null, historico_resumo || null,
      orcamento || 0, adiantamento || 0, pago || 0
    ]);

    res.json({ success: true, lead: result.rows[0] });
  } catch (err) {
    console.error('Erro ao salvar lead:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads — listar todos os leads
app.get('/api/leads', async (req, res) => {
  try {
    const { nicho, status } = req.query;
    let query = 'SELECT * FROM leads WHERE 1=1';
    const params = [];

    if (nicho) { params.push(nicho); query += ` AND nicho = $${params.length}`; }
    if (status) { params.push(status); query += ` AND status = $${params.length}`; }

    query += ' ORDER BY atualizado_em DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/leads/:id — atualizar lead
app.patch('/api/leads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const fields = req.body;
    const keys = Object.keys(fields);
    if (keys.length === 0) return res.status(400).json({ error: 'Nenhum campo enviado' });

    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = keys.map(k => fields[k]);
    values.push(id);

    const result = await pool.query(
      `UPDATE leads SET ${setClause}, atualizado_em = NOW() WHERE id = $${values.length} RETURNING *`,
      values
    );
    res.json({ success: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id
app.delete('/api/leads/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/metricas — faturamento
app.get('/api/metricas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(SUM(orcamento), 0) as previsao_total,
        COALESCE(SUM(pago), 0) as faturamento_real,
        COUNT(*) as total_leads,
        COUNT(CASE WHEN status = 'quente' THEN 1 END) as quentes,
        COUNT(CASE WHEN status = 'frio' THEN 1 END) as frios,
        COUNT(CASE WHEN status = 'fechado' THEN 1 END) as fechados,
        COUNT(CASE WHEN status = 'sem_interesse' THEN 1 END) as sem_interesse
      FROM leads
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reaquecimento — leads que precisam de reaquecimento
app.get('/api/reaquecimento', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM leads
      WHERE status IN ('quente', 'frio')
      AND reaquecimento_count < 3
      AND (
        (reaquecimento_count = 0 AND ultimo_contato < NOW() - INTERVAL '1 hour')
        OR (reaquecimento_count = 1 AND ultimo_contato < NOW() - INTERVAL '12 hours')
        OR (reaquecimento_count = 2 AND ultimo_contato < NOW() - INTERVAL '20 hours')
      )
      ORDER BY ultimo_contato ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reaquecimento/:id/confirmar — marca reaquecimento como enviado
app.post('/api/reaquecimento/:id/confirmar', async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE leads SET
        reaquecimento_count = reaquecimento_count + 1,
        ultimo_contato = NOW(),
        atualizado_em = NOW()
      WHERE id = $1 RETURNING *
    `, [req.params.id]);
    res.json({ success: true, lead: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve CRM frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDB();
  console.log(`CRM rodando na porta ${PORT}`);
});
