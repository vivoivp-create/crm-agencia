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

app.get('/api/contatos', async (req, res) => {
  try {
    const { status, busca } = req.query;
    let query = 'SELECT * FROM contatos';
    const params = [];
    const conditions = [];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    if (busca) { params.push(`%${busca}%`); conditions.push(`(nome ILIKE $${params.length} OR empresa ILIKE $${params.length})`); }
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY criado_em DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/contatos', async (req, res) => {
  try {
    const { nome, empresa, telefone, email, origem, status, notas } = req.body;
    const result = await pool.query(
      'INSERT INTO contatos (nome, empresa, telefone, email, origem, status, notas) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [nome, empresa, telefone, email, origem || 'manual', status || 'novo', notas]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/contatos/:id', async (req, res) => {
  try {
    const { nome, empresa, telefone, email, status, notas } = req.body;
    const result = await pool.query(
      'UPDATE contatos SET nome=$1, empresa=$2, telefone=$3, email=$4, status=$5, notas=$6, atualizado_em=NOW() WHERE id=$7 RETURNING *',
      [nome, empresa, telefone, email, status, notas, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/contatos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM contatos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/conversas/:contato_id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM conversas WHERE contato_id=$1 ORDER BY criado_em ASC', [req.params.contato_id]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/conversas', async (req, res) => {
  try {
    const { contato_id, mensagem, direcao, canal } = req.body;
    const result = await pool.query(
      'INSERT INTO conversas (contato_id, mensagem, direcao, canal) VALUES ($1,$2,$3,$4) RETURNING *',
      [contato_id, mensagem, direcao || 'entrada', canal || 'whatsapp']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/projetos', async (req, res) => {
  try {
    const result = await pool.query('SELECT p.*, c.nome as contato_nome FROM projetos p LEFT JOIN contatos c ON p.contato_id = c.id ORDER BY p.criado_em DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/projetos', async (req, res) => {
  try {
    const { contato_id, titulo, descricao, responsavel, status, progresso, prazo } = req.body;
    const result = await pool.query(
      'INSERT INTO projetos (contato_id, titulo, descricao, responsavel, status, progresso, prazo) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [contato_id, titulo, descricao, responsavel, status || 'iniciando', progresso || 0, prazo]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/projetos/:id', async (req, res) => {
  try {
    const { titulo, descricao, responsavel, status, progresso, prazo } = req.body;
    const result = await pool.query(
      'UPDATE projetos SET titulo=$1, descricao=$2, responsavel=$3, status=$4, progresso=$5, prazo=$6, atualizado_em=NOW() WHERE id=$7 RETURNING *',
      [titulo, descricao, responsavel, status, progresso, prazo, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const [leads, clientes, conversao, projetos, funil] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM contatos WHERE status != 'cliente' AND status != 'perdido'`),
      pool.query(`SELECT COUNT(*) FROM contatos WHERE status = 'cliente'`),
      pool.query(`SELECT ROUND(COUNT(*) FILTER (WHERE status='cliente') * 100.0 / NULLIF(COUNT(*),0), 0) as taxa FROM contatos`),
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
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'agencia123';
  console.log('GET webhook - token:', req.query['hub.verify_token']);
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

function corrigirTelefone(telefone) {
  if (telefone.startsWith('55') && telefone.length === 12) {
    const ddd = telefone.slice(2, 4);
    const numero = telefone.slice(4);
    const telefoneCorrigido = '55' + ddd + '9' + numero;
    console.log(`Numero corrigido: ${telefone} -> ${telefoneCorrigido}`);
    return telefoneCorrigido;
  }
  return telefone;
}

function detectarNicho(texto) {
  const t = texto.toLowerCase();
  if (t.includes('hamburguer') || t.includes('hamburgueria') || t.includes('hambúrguer') || t.includes('burger') || t.includes('hamburgeria')) return 'hamburguer';
  if (t.includes('japones') || t.includes('japonês') || t.includes('japonesa') || t.includes('sushi') || t.includes('temaki')) return 'japones';
  return null;
}

function detectarEtapa(historico) {
  const textoCompleto = historico.map(m => m.content).join(' ');
  const nicho = detectarNicho(textoCompleto);
  const videoEnviado = textoCompleto.includes('youtube.com/shorts');
  const planosApresentados = textoCompleto.toLowerCase().includes('basico') || textoCompleto.toLowerCase().includes('básico') || textoCompleto.toLowerCase().includes('standard') || textoCompleto.toLowerCase().includes('max plus');
  const leadFechado = textoCompleto.toLowerCase().includes('fabiano') && (textoCompleto.toLowerCase().includes('entrar em contato') || textoCompleto.toLowerCase().includes('fechar'));
  if (leadFechado) return { etapa: 5, nicho };
  if (planosApresentados) return { etapa: 4, nicho };
  if (videoEnviado) return { etapa: 3, nicho };
  if (nicho) return { etapa: 2, nicho };
  return { etapa: 1, nicho: null };
}

app.post('/webhook', async (req, res) => {
  try {
    console.log('POST webhook recebido:', JSON.stringify(req.body).substring(0, 300));
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    const contact = change?.value?.contacts?.[0];
    if (!message || message.type !== 'text') {
      console.log('Ignorando - nao e texto');
      return res.sendStatus(200);
    }
    const telefoneOriginal = message.from;
    const telefone = corrigirTelefone(telefoneOriginal);
    const texto = message.text.body;
    const nomeWhatsapp = contact?.profile?.name || 'Desconhecido';
    console.log('Processando:', telefone, nomeWhatsapp, texto);
    let contato = await pool.query('SELECT * FROM contatos WHERE telefone=$1', [telefone]);
    if (contato.rows.length === 0) {
      contato = await pool.query('SELECT * FROM contatos WHERE telefone=$1', [telefoneOriginal]);
    }
    if (contato.rows.length === 0) {
      contato = await pool.query(
        `INSERT INTO contatos (nome, telefone, origem, status) VALUES ($1,$2,'whatsapp','novo') RETURNING *`,
        [nomeWhatsapp, telefone]
      );
    }
    const contatoId = contato.rows[0].id;
    const historico = await pool.query(
      `SELECT mensagem, direcao FROM conversas WHERE contato_id=$1 ORDER BY criado_em ASC LIMIT 30`,
      [contatoId]
    );
    const mensagensHistorico = historico.rows.map(row => ({
      role: row.direcao === 'entrada' ? 'user' : 'assistant',
      content: row.mensagem
    }));
    const { etapa, nicho } = detectarEtapa(mensagensHistorico);
    console.log(`Etapa detectada: ${etapa} | Nicho: ${nicho}`);
    await pool.query(
      `INSERT INTO conversas (contato_id, mensagem, direcao, canal, lida) VALUES ($1,$2,'entrada','whatsapp',false)`,
      [contatoId, texto]
    );
    mensagensHistorico.push({ role: 'user', content: texto });
    let instrucaoEtapa = '';
    if (etapa === 1) {
      instrucaoEtapa = 'ETAPA ATUAL: 1 - Pergunte qual tipo de negócio o cliente tem. Seja breve e simpático. Não peça nome ainda.';
    } else if (etapa === 2) {
      instrucaoEtapa = `ETAPA ATUAL: 2 - Nicho já identificado: ${nicho}. Envie AGORA o link do portfólio correspondente e gere desejo. NÃO pergunte o nicho de novo.`;
    } else if (etapa === 3) {
      instrucaoEtapa = `ETAPA ATUAL: 3 - Vídeo já enviado. Gere mais desejo e apresente os planos do método ${nicho === 'hamburguer' ? 'Burger Viral' : 'Fome Visual'}. NÃO envie o vídeo de novo.`;
    } else if (etapa === 4) {
      instrucaoEtapa = 'ETAPA ATUAL: 4 - Planos já apresentados. Colete: nome completo e nome do negócio. Depois passe pro Fabiano fechar.';
    } else {
      instrucaoEtapa = 'ETAPA ATUAL: 5 - Lead qualificado. Mantenha conversa amigável.';
    }
    console.log('Chamando Claude...');
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system: `Você é o assistente comercial da Vigore Agência Digital. Responsável: Fabiano.

IDENTIDADE:
- Fale de forma humana, curta e direta
- Nunca pareça robô
- Use emojis com naturalidade
- Regra de ouro: vender primeiro, depois coletar dados

FLUXO OBRIGATÓRIO (siga EXATAMENTE essa ordem, nunca pule nem repita etapa):
1. Descobrir o nicho do cliente
2. Enviar link do portfólio assim que identificar o nicho
3. Gerar desejo — perguntar: fez sentido? O que achou?
4. Apresentar os planos do método correto
5. Capturar nome completo e nome do negócio
6. Informar que o Fabiano vai entrar em contato para fechar

REGRAS CRÍTICAS:
- NUNCA pergunte nome antes da etapa 5
- NUNCA repita perguntas já respondidas no histórico
- NUNCA ignore o que o cliente já disse
- NUNCA volte a perguntar o nicho se já foi identificado
- Leia TODO o histórico antes de responder

PORTFÓLIO:

HAMBÚRGUER 🍔
Método Burger Viral
Link: https://www.youtube.com/shorts/qv-QmvltN5k
Planos:
🥉 Básico — R$69,90
🥈 Standard — R$197,90
🥇 Max Plus — R$297,90

JAPONÊS 🍣
Método Fome Visual
Link: https://www.youtube.com/shorts/36uq3MaaHic
Planos:
🥉 Básico — R$89,90
🥈 Standard — R$197,90
🥇 Max Plus — R$297,90

SEMPRE DIZER: Você só paga após ver o material pronto 🔥

CAPTURA DE LEAD:
Após apresentar planos, colete nome completo e nome do negócio.
Depois diga: "Perfeito! Vou passar pro Fabiano agora. Ele entra em contato em breve para fechar com você 🤝"

OUTROS NICHOS:
Se não for hambúrguer nem japonês, adapte mostrando que a Vigore produz conteúdo visual com IA para qualquer negócio.

---
${instrucaoEtapa}`,
        messages: mensagensHistorico
      })
    });
    const claudeData = await claudeRes.json();
    console.log('Claude status:', claudeRes.status, JSON.stringify(claudeData).substring(0, 200));
    const resposta = claudeData.content?.[0]?.text;
    if (resposta) {
      if (etapa >= 4) {
        await pool.query(`UPDATE contatos SET status='qualificado', atualizado_em=NOW() WHERE id=$1`, [contatoId]);
        console.log('Lead qualificado - status atualizado no CRM');
      } else if (etapa >= 2 && contato.rows[0].status === 'novo') {
        await pool.query(`UPDATE contatos SET status='em_contato', atualizado_em=NOW() WHERE id=$1`, [contatoId]);
      }
      if (nicho) {
        await pool.query(`UPDATE contatos SET empresa=COALESCE(NULLIF(empresa,''), $1), atualizado_em=NOW() WHERE id=$2`, [nicho, contatoId]);
      }
      await pool.query(`INSERT INTO conversas (contato_id, mensagem, direcao, canal) VALUES ($1,$2,'saida','whatsapp')`, [contatoId, resposta]);
      console.log('Enviando WhatsApp para:', telefone, '| Token:', process.env.WHATSAPP_TOKEN?.substring(0, 15));
      const waRes = await fetch(`https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: telefone,
          type: 'text',
          text: { body: resposta }
        })
      });
      const waData = await waRes.json();
      console.log('WhatsApp resposta:', JSON.stringify(waData).substring(0, 200));
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro webhook:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`CRM rodando na porta ${PORT}`));
});
