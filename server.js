const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const https = require('https');

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

// Função para chamar a API do Anthropic via https nativo
function callAnthropic(apiKey, messageText) {
    return new Promise((resolve, reject) => {
          const payload = JSON.stringify({
                  model: 'claude-haiku-4-5',
                  max_tokens: 1024,
                  system: 'Você é um assistente virtual da Agência CRM. Responda de forma simpática, direta e profissional em português.',
                  messages: [{ role: 'user', content: messageText }]
          });

                           const options = {
                                   hostname: 'api.anthropic.com',
                                   path: '/v1/messages',
                                   method: 'POST',
                                   headers: {
                                             'x-api-key': apiKey,
                                             'anthropic-version': '2023-06-01',
                                             'content-type': 'application/json',
                                             'content-length': Buffer.byteLength(payload)
                                   }
                           };

                           const req = https.request(options, (res) => {
                                   let data = '';
                                   res.on('data', (chunk) => { data += chunk; });
                                   res.on('end', () => {
                                             try {
                                                         const parsed = JSON.parse(data);
                                                         resolve(parsed);
                                             } catch (e) {
                                                         reject(new Error('Falha ao parsear resposta Anthropic: ' + data));
                                             }
                                   });
                           });

                           req.on('error', reject);
          req.setTimeout(30000, () => {
                  req.destroy();
                  reject(new Error('Timeout na chamada Anthropic'));
          });
          req.write(payload);
          req.end();
    });
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

// ============================================
// WEBHOOK WHATSAPP
// ============================================

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// GET — verificação do webhook pelo Meta
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

          if (mode === 'subscribe' && token === VERIFY_TOKEN) {
                console.log('Webhook verificado!');
                res.status(200).send(challenge);
          } else {
                res.sendStatus(403);
          }
});

// Função para enviar mensagem pelo WhatsApp
function sendWhatsAppMessage(phoneNumberId, token, to, text) {
    return new Promise((resolve, reject) => {
          const payload = JSON.stringify({
                  messaging_product: 'whatsapp',
                  to: to,
                  type: 'text',
                  text: { body: text }
          });

                           const options = {
                                   hostname: 'graph.facebook.com',
                                   path: `/v19.0/${phoneNumberId}/messages`,
                                   method: 'POST',
                                   headers: {
                                             'Authorization': `Bearer ${token}`,
                                             'Content-Type': 'application/json',
                                             'content-length': Buffer.byteLength(payload)
                                   }
                           };

                           const req = https.request(options, (res) => {
                                   let data = '';
                                   res.on('data', (chunk) => { data += chunk; });
                                   res.on('end', () => {
                                             try { resolve(JSON.parse(data)); }
                                             catch (e) { resolve({ raw: data }); }
                                   });
                           });

                           req.on('error', reject);
          req.setTimeout(15000, () => {
                  req.destroy();
                  reject(new Error('Timeout ao enviar WhatsApp'));
          });
          req.write(payload);
          req.end();
    });
}

// POST — receber mensagens do WhatsApp
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);

           try {
                 const body = req.body;
                 const entry = body?.entry?.[0];
                 const change = entry?.changes?.[0];
                 const message = change?.value?.messages?.[0];

      if (!message || message.type !== 'text') return;

      const from = message.from;
                 const text = message.text.body;

      console.log(`Mensagem de ${from}: ${text}`);

      // Verificar se a ANTHROPIC_API_KEY está configurada
      if (!ANTHROPIC_API_KEY) {
              console.error('ERRO: ANTHROPIC_API_KEY não configurada!');
              return;
      }

      // Chamar Claude AI usando https nativo (sem dependência de fetch)
      let reply = 'Desculpe, não consegui processar sua mensagem.';
                 try {
                         const claudeData = await callAnthropic(ANTHROPIC_API_KEY, text);
                         console.log('Resposta Anthropic status:', claudeData.type, '| erro:', claudeData.error);

                   if (claudeData.content && claudeData.content[0] && claudeData.content[0].text) {
                             reply = claudeData.content[0].text;
                   } else if (claudeData.error) {
                             console.error('Erro da API Anthropic:', JSON.stringify(claudeData.error));
                             reply = 'Desculpe, estou com dificuldades técnicas no momento. Tente novamente em breve.';
                   }
                 } catch (claudeErr) {
                         console.error('Erro ao chamar Anthropic:', claudeErr.message);
                 }

      console.log(`Resposta do Claude: ${reply}`);

      // Enviar resposta pelo WhatsApp
      if (WHATSAPP_TOKEN && PHONE_NUMBER_ID) {
              try {
                        const waResult = await sendWhatsAppMessage(PHONE_NUMBER_ID, WHATSAPP_TOKEN, from, reply);
                        console.log(`Resposta enviada para ${from}:`, JSON.stringify(waResult).substring(0, 100));
              } catch (waErr) {
                        console.error('Erro ao enviar WhatsApp:', waErr.message);
              }
      } else {
              console.warn('AVISO: WHATSAPP_TOKEN ou WHATSAPP_PHONE_ID não configurados. Resposta não enviada.');
      }

      // Salvar no CRM
      await pool.query(`
            INSERT INTO leads (telefone, ultima_mensagem, ultimo_contato, atualizado_em)
                  VALUES ($1, $2, NOW(), NOW())
                        ON CONFLICT (telefone) DO UPDATE SET
                                ultima_mensagem = $2,
                                        ultimo_contato = NOW(),
                                                atualizado_em = NOW()
                                                    `, [from, text]);

           } catch (err) {
                 console.error('Erro no webhook:', err.message, err.stack);
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
    // Log de diagnóstico das variáveis de ambiente
             console.log('ANTHROPIC_API_KEY configurada:', !!ANTHROPIC_API_KEY);
    console.log('WHATSAPP_TOKEN configurado:', !!WHATSAPP_TOKEN);
    console.log('WHATSAPP_PHONE_ID configurado:', !!PHONE_NUMBER_ID);
    console.log('WHATSAPP_VERIFY_TOKEN configurado:', !!VERIFY_TOKEN);
});
// v3
