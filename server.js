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
      const match = m.content.match(/(?:meu nome[\s\S]*?[eé]|me chamo|sou o|sou a)\s+([A-Z][a-záàâãéèêíïóôõúç]+(?:\s[A-Z][a-záàâãéèêíïóôõúç]+)*)/i);
      if (match) return match[1];
    }
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

function vendaNaoDesenvolveu(etapa) {
  return etapa < 6;
}

function buildFollowupPrompt(etapaInfo, sequencia) {
  const etapa = etapaInfo.etapa;
  const nicho = etapaInfo.nicho;
  const nichoLabel = nicho === 'hamburguer' ? 'hamburguer/fast food' : (nicho === 'japones' ? 'restaurante japones' : 'restaurante');

  const mensagens = {
    1: {
      1: 'Ei, sumiu! Ainda tem interesse em aumentar o movimento do seu ' + nichoLabel + '? Me conta mais sobre seu negocio',
      2: 'Oi! So passando pra lembrar que temos resultados incriveis para ' + nichoLabel + '. Quer ver alguns exemplos do nosso trabalho? Pode ser um divisor de aguas pro seu negocio',
      3: 'Ultima chamada! Nossos clientes de ' + nichoLabel + ' estao faturando muito mais com nossas estrategias de conteudo. Se quiser saber como, e so me chamar. Estou aqui!'
    },
    2: {
      1: 'Oi! Vi que voce nao chegou a ver nosso portfolio. Os resultados que entregamos para ' + nichoLabel + ' sao bem impressionantes. Quer dar uma olhadinha?',
      2: 'E ai, tudo bem? Estou aqui caso queira retomar nossa conversa sobre marketing para ' + nichoLabel + '. Temos cases de sucesso que podem te interessar',
      3: 'Ultima oportunidade! Se tiver interesse em transformar o marketing do seu ' + nichoLabel + ', e so responder essa mensagem. Estamos com agenda aberta essa semana!'
    },
    3: {
      1: 'Oi! Vi que ficou na duvida sobre os planos. Posso te explicar melhor as diferencas entre eles. Qual parte te gerou mais duvida?',
      2: 'E ai! Ainda pensando? Lembra que voce so paga depois de ver o material pronto. Zero risco pra voce. O que acha de a gente dar o proximo passo?',
      3: 'Ultimo aviso! Nossa agenda esta quase cheia essa semana. Se tiver interesse em garantir sua vaga, e so responder agora. O investimento se paga com poucos clientes a mais por mes!'
    },
    4: {
      1: 'Oi! Falta pouco! So preciso do seu nome e do @ do instagram da sua empresa pra gente finalizar. Me passa essas infos?',
      2: 'E ai, ainda por aqui? E simples: me passa seu nome completo e o instagram do seu negocio que ja encaminhamos tudo pro Fabiano!',
      3: 'Ultimo recado! Se ainda tiver interesse, me passa so o seu nome e o @ do instagram. O Fabiano ja esta esperando pra entrar em contato com voce!'
    }
  };

  const etapaKey = etapa <= 4 ? etapa : 4;
  const msgs = mensagens[etapaKey] || mensagens[1];
  return msgs[sequencia] || msgs[1];
}

function buildSystemPrompt(etapaInfo, ehCampanha, ehCampanhaHamb) {  const etapa = etapaInfo.etapa;  const nicho = etapaInfo.nicho || '';  const ehHamburguer = nicho === 'hamburguer' || ehCampanhaHamb;  const ehJapones = nicho === 'japones';  const nichoLabel = ehHamburguer ? 'hamburguer' : (ehJapones ? 'japonesa' : nicho || 'restaurante');  const pacotesHamb = 'BASICO R$69,90: 1 video + 8 fotos 4K + 30 roteiros | STANDARD R$197,90: 3 videos + 20 fotos 4K + 40 roteiros | MAX PLUS R$297,90: 5 videos + 35 fotos 4K + 50 roteiros. Paga so apos aprovar.';  const pacotesJap = 'BASICO R$89,90: 1 video + 8 fotos 4K + 30 roteiros | STANDARD R$197,90: 3 videos + 20 fotos 4K + 40 roteiros | MAX PLUS R$297,90: 5 videos + 35 fotos 4K + 50 roteiros. Paga so apos aprovar.';  const pacotes = ehHamburguer ? pacotesHamb : (ehJapones ? pacotesJap : pacotesHamb);  return `Voce e o assistente comercial da Vigore Agencia Digital. Responsavel: Fabiano. MISSAO: criar conteudos visuais que aumentam desejo, retencao e vendas para delivery. POSICIONAMENTO: Nao vendemos videos. Vendemos desejo visual.TOM: humano, curto, direto, confiante. NUNCA use: "vou verificar", "estou aqui para ajudar", "fico a disposicao", "posso ajudar com mais alguma duvida". SEMPRE finalizar com pergunta. Max 4 linhas por mensagem. NUNCA apresente lista generica de servicos (SEO, trafego pago) antes de vender os videos.PRODUTOS: Metodo Burger Viral (hamburguerias) portfolio: https://www.youtube.com/shorts/Fy1022ucX0M e https://www.youtube.com/shorts/qv-QmvltN5k | Metodo Fome Visual (japonesa) portfolio: https://www.youtube.com/shorts/36uq3MaaHic e https://www.youtube.com/shorts/n78ISZ6acwkPACOTES (${nichoLabel}): ${pacotes}FLUXO: 1. ABERTURA: pergunte "Oi! Voce trabalha com hamburguer, comida japonesa ou outro nicho?" 2. APOS NICHO hamburguer: mande https://www.youtube.com/shorts/Fy1022ucX0M com "Carne na chapa. Queijo derretendo. Molho escorrendo. O cliente ve isso e ja ta pedindo antes de abrir o delivery. Faz sentido?" 3. APOS NICHO japonesa: mande https://www.youtube.com/shorts/36uq3MaaHic com "Faca cortando salmao. Brilho da peca. Montagem do sushi. O desejo ja venceu antes da primeira mordida. Faz sentido?" 4. QUANDO PEDIREM VALOR: mostre IMEDIATAMENTE a tabela de pacotes, sem pedir mais info antes. Se nicho indefinido: "Burger Viral a partir R$69,90 ou Fome Visual a partir R$89,90. Qual seu nicho?" 5. COMO FUNCIONA: "Voce escolhe o pacote, a gente cria, voce recebe, aprova e so entao paga." 6. FECHAMENTO: pedir nome, Instagram, WhatsApp e cidade.OBJEC0ES: DESCONTO: "Valor ja e o menor pra esse nivel. Voce recebe, aprova e so paga. Zero risco. O que travou?" — se insistir oferecer Basico. PRAZO: Basico 1-2 dias, Standard 2-4 dias, Max Plus 3-5 dias. PEDIDO HUMANO/ATENDENTE: "Claro! Fala com o Fabiano: wa.me/5543996877898" — NUNCA resistir. OUTROS NICHOS (pizzaria etc): atender normalmente com pacotes do Burger Viral.Etapa: ${etapa || 1} | Nicho: ${nichoLabel}`;}
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

// Marcar mensagens de entrada como lidas
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

// PATCH route for updating specific fields (Kanban drag & drop)
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

// Respostas rapidas
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

// Kanban colunas
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

// Notas do lead
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

// Endpoint de diagnostico do bot
app.get('/api/bot-status', async function(req, res) {
  try {
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const token = process.env.WHATSAPP_TOKEN;
    const claudeKey = process.env.CLAUDE_API_KEY;
    
    // Test WhatsApp API token validity
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
    
    // Count DB stats
    const contatosResult = await pool.query('SELECT COUNT(*) as total, COUNT(CASE WHEN bot_pausado THEN 1 END) as pausados FROM contatos');
    const convsResult = await pool.query('SELECT COUNT(*) as total FROM conversas WHERE criado_em > NOW() - INTERVAL \'24 hours\');
    
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
