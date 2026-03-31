import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import { upsertSLASnapshots, getSLASnapshots } from './service.js';
import { initDB } from './db.js';
import { fetchAllTickets, fetchCustomSearchTickets } from './scraper.js';
import { fetchTramites } from './tramites.js';
import { fetchVisualizacoes } from './visualizacoes.js';
import { processTicketsSLA } from './slaCalculator.js';
import { getTicketNotes, createTicketNote, getAllTicketIds } from './ticketNotes.js';

const jar = new CookieJar();
const session = wrapper(axios.create({ jar, withCredentials: true }));

const app = express();
const PORT = process.env.PORT || 3210;

// Middleware
app.use(express.json());
app.use(cors());

// ─── Autenticacao via API_KEY ──────────────────────────────────
// Todas as rotas exigem o header Authorization com o valor
// identico a variavel API_KEY do .env (104 caracteres).
// ────────────────────────────────────────────────────────────────
const API_KEY = process.env.API_KEY;

if (!API_KEY || API_KEY.length !== 104) {
    console.error('ERRO FATAL: API_KEY ausente ou invalida no .env (deve ter exatamente 104 caracteres).');
    process.exit(1);
}

app.use((req, res, next) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        return res.status(401).json({ error: 'Header Authorization ausente' });
    }

    if (authHeader.slice(0, 104) !== API_KEY) {
        return res.status(403).json({ error: 'Chave de autenticacao invalida' });
    }

    next();
});

// ─── Cache SLA em memória + Background Processing ─────────────
// O POST /sla agora responde imediatamente com dados do banco
// e dispara o calculo pesado em background. O cache em memoria
// evita disparar processamento duplicado dentro do TTL.
// ────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

const slaCache = {
    lastRun: null,       // Date da ultima execucao bem-sucedida
    response: null,      // Objeto JSON da ultima execucao
};

const slaBackground = {
    isProcessing: false, // true enquanto o background job esta rodando
    startedAt: null,     // Date de inicio do processamento atual
    lastError: null,     // mensagem de erro do ultimo processamento (null se ok)
    phase: 'idle',       // 'idle' | 'login' | 'scraping' | 'calculating' | 'persisting' | 'done' | 'error'
};

/**
 * Executa o calculo de SLA em background (sem bloquear a resposta HTTP).
 * Atualiza slaCache e slaBackground conforme progride.
 */
async function runSLABackground(team) {
    if (slaBackground.isProcessing) {
        console.log('[sla-bg] Processamento ja em andamento, ignorando.');
        return;
    }

    slaBackground.isProcessing = true;
    slaBackground.startedAt = getNowBR();
    slaBackground.lastError = null;
    slaBackground.phase = 'login';

    try {
        // Login
        console.log('[sla-bg] Fazendo login...');
        const loginSuccess = await attemptLogin(1);
        if (!loginSuccess) {
            const retrySuccess = await attemptLogin(2);
            if (!retrySuccess) {
                throw new Error('Falha no login apos 2 tentativas');
            }
        }

        // Scraping
        slaBackground.phase = 'scraping';
        console.log('[sla-bg] Buscando tickets via customSearchMenu=28720...');
        const tickets = await fetchCustomSearchTickets('28720', session, login);
        console.log(`[sla-bg] ${tickets.length} tickets encontrados. Calculando SLA...`);

        // Calculo de SLA
        slaBackground.phase = 'calculating';
        const ticketsWithSLA = await processTicketsSLA(tickets, session, login, team, 10);

        const now = getNowBR();
        const pad = n => String(n).padStart(2, '0');
        const processedAt =
            `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ` +
            `${pad(now.getHours())}:${pad(now.getMinutes())}`;

        // Persistir no banco
        slaBackground.phase = 'persisting';
        await upsertSLASnapshots(ticketsWithSLA, now);

        console.log(`[sla-bg] Calculo concluido para ${ticketsWithSLA.length} tickets.`);

        // Atualizar cache em memoria
        const responseBody = {
            message: `SLA calculado para ${ticketsWithSLA.length} tickets`,
            ticketCount: ticketsWithSLA.length,
            processedAt,
            team,
            tickets: ticketsWithSLA,
        };

        slaCache.lastRun = now;
        slaCache.response = responseBody;
        slaBackground.phase = 'done';
    } catch (error) {
        console.error('[sla-bg] Erro no processamento:', error.message);
        slaBackground.lastError = error.message;
        slaBackground.phase = 'error';
    } finally {
        slaBackground.isProcessing = false;
    }
}

// Função para obter data/hora no fuso de São Paulo
function getNowBR() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

async function login() {
    try {
        const url = "https://portaldocliente.praxio.com.br/Home/Entrar";
        const loginData = {
            txtLogin: process.env.PORTAL_LOGIN,
            txtSenha: process.env.PORTAL_PASSWORD,
            ReturnUrl: ""
        };

        const res = await session.post(url, new URLSearchParams(loginData), {
            headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });

        console.log("✅ Login status:", res.status);
        return res;
    } catch (error) {
        return error.response;
    }
}

// Função para tentar login
async function attemptLogin(attempt = 1) {
    console.log(`Tentativa de login ${attempt}/2...`);

    const loginResponse = await login()

    if (!loginResponse) {
        console.log(`Tentativa ${attempt}: Erro na requisição de login`);
        return false;
    }

    console.log(`Tentativa ${attempt}: Login realizado com sucesso!`);
    return true;
}

// Rota para scraping paginado de todos os tickets de um cliente
app.get('/scrape-all/:clientName', async (req, res) => {
    try {
        const clientName = req.params.clientName;
        console.log(`🚀 Iniciando scraping paginado para o cliente: ${clientName}`);

        // Garantir login antes de iniciar o scraping
        console.log('🔑 Fazendo login antes do scraping...');
        const loginSuccess = await attemptLogin(1);
        if (!loginSuccess) {
            const retrySuccess = await attemptLogin(2);
            if (!retrySuccess) {
                return res.status(401).json({
                    error: 'Falha no login',
                    message: 'Não foi possível autenticar no portal após 2 tentativas'
                });
            }
        }

        // Passar session e login function para o scraper poder re-autenticar se necessário
        const tickets = await fetchAllTickets(clientName, session, login);

        res.json({
            message: `Scraping concluído para o cliente ${clientName}`,
            client: clientName,
            ticketCount: tickets.length,
            tickets: tickets.map(t => ({
                number: t.number,
                title: t.title,
                opening: t.opening,
                lastUpdate: t.lastUpdate,
                client: t.client,
                module: t.module,
                person: t.person,
                responsible: t.responsible,
                status: t.status
            }))
        });
    } catch (error) {
        console.error(`❌ Erro no scraping paginado:`, error.message);
        res.status(500).json({
            error: 'Erro interno no servidor',
            message: error.message
        });
    }
});

// Rota para scraping via customSearchMenu (busca salva no portal)
app.get('/scrape-custom/:customSearchMenuId', async (req, res) => {
    try {
        const customSearchMenuId = req.params.customSearchMenuId;
        console.log(`🚀 Iniciando scraping via customSearchMenu=${customSearchMenuId}`);

        // Garantir login antes de iniciar o scraping
        console.log('🔑 Fazendo login antes do scraping...');
        const loginSuccess = await attemptLogin(1);
        if (!loginSuccess) {
            const retrySuccess = await attemptLogin(2);
            if (!retrySuccess) {
                return res.status(401).json({
                    error: 'Falha no login',
                    message: 'Não foi possível autenticar no portal após 2 tentativas'
                });
            }
        }

        const tickets = await fetchCustomSearchTickets(customSearchMenuId, session, login);

        res.json({
            message: `Scraping concluído para customSearchMenu=${customSearchMenuId}`,
            customSearchMenuId,
            ticketCount: tickets.length,
            tickets: tickets.map(t => ({
                number: t.number,
                link: t.link,
                title: t.title,
                opening: t.opening,
                lastUpdate: t.lastUpdate,
                team: t.team,
                client: t.client,
                module: t.module,
                person: t.person,
                responsible: t.responsible,
                status: t.status
            }))
        });
    } catch (error) {
        console.error(`❌ Erro no scraping customSearchMenu:`, error.message);
        res.status(500).json({
            error: 'Erro interno no servidor',
            message: error.message
        });
    }
});

// ─── Trâmites ──────────────────────────────────────────────────
// GET /tramites/:ticketId
//
// Retorna todos os trâmites de um ticket.
//
// Query params opcionais:
//   ?origin=cliente|operador|privado  - filtra por origem
//   ?search=texto                     - filtra por conteúdo
// ────────────────────────────────────────────────────────────────
app.get('/tramites/:ticketId', async (req, res) => {
    try {
        const { ticketId } = req.params;
        const { origin, search } = req.query;

        if (!ticketId || isNaN(ticketId)) {
            return res.status(400).json({ error: 'ticketId deve ser um número válido' });
        }

        console.log(`[tramites] Buscando trâmites do ticket ${ticketId}...`);
        const result = await fetchTramites(ticketId, session, login);

        let tramites = result.tramites;

        // Filtro por origem
        if (origin) {
            tramites = tramites.filter(t => t.origin === origin);
        }

        // Filtro por texto
        if (search) {
            const term = search.toLowerCase();
            tramites = tramites.filter(t =>
                t.content.toLowerCase().includes(term) ||
                t.author?.toLowerCase().includes(term)
            );
        }

        res.json({
            ticketId: result.ticketId,
            total: tramites.length,
            tramites,
        });
    } catch (error) {
        console.error(`[tramites] Erro:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar trâmites', message: error.message });
    }
});

// ─── Visualizações ─────────────────────────────────────────────
// GET /visualizacoes/:ticketId
//
// Retorna quem visualizou o ticket.
// ────────────────────────────────────────────────────────────────
app.get('/visualizacoes/:ticketId', async (req, res) => {
    try {
        const { ticketId } = req.params;

        if (!ticketId || isNaN(ticketId)) {
            return res.status(400).json({ error: 'ticketId deve ser um número válido' });
        }

        console.log(`[visualizacoes] Buscando visualizações do ticket ${ticketId}...`);
        const result = await fetchVisualizacoes(ticketId, session, login);

        res.json(result);
    } catch (error) {
        console.error(`[visualizacoes] Erro:`, error.message);
        res.status(500).json({ error: 'Erro ao buscar visualizações', message: error.message });
    }
});

// ─── SLA ────────────────────────────────────────────────────────
// POST /sla
//
// Responde IMEDIATAMENTE com os dados do banco (sla_snapshots).
// Se o cache em memoria estiver valido (< 2h), retorna do cache.
// Em ambos os casos, se o cache expirou, dispara o recalculo
// em background (sem bloquear a resposta).
//
// Body JSON:
//   { "team": ["VITOR.OLIVEIRA", "AURORA.SIMONELLI", ...] }
// ────────────────────────────────────────────────────────────────
app.post('/sla', async (req, res) => {
    try {
        const { team } = req.body;

        // Validacao do body
        if (!team || !Array.isArray(team) || team.length === 0) {
            return res.status(400).json({
                error: 'Campo "team" e obrigatorio e deve ser um array de nomes de atendentes',
                example: { team: ['VITOR.OLIVEIRA', 'AURORA.SIMONELLI'] }
            });
        }

        if (!team.every(name => typeof name === 'string' && name.trim().length > 0)) {
            return res.status(400).json({
                error: 'Todos os itens de "team" devem ser strings nao-vazias'
            });
        }

        const now = getNowBR();

        // 1) Cache em memoria valido -> retorna imediatamente
        if (slaCache.lastRun && slaCache.response) {
            const elapsed = now - slaCache.lastRun;
            if (elapsed < CACHE_TTL_MS) {
                const remainingMin = Math.round((CACHE_TTL_MS - elapsed) / 1000 / 60);
                return res.json({
                    ...slaCache.response,
                    cached: true,
                    source: 'memory',
                    cacheExpiresIn: `${remainingMin}min`,
                });
            }
        }

        // 2) Cache expirado ou inexistente -> responder com dados do banco
        //    e disparar recalculo em background
        console.log(`[sla] Cache expirado/vazio. Buscando snapshots do banco...`);
        const dbTickets = await getSLASnapshots();

        // Disparar background (fire-and-forget)
        if (!slaBackground.isProcessing) {
            console.log(`[sla] Disparando calculo de SLA em background para ${team.length} atendentes...`);
            runSLABackground(team);
        } else {
            console.log(`[sla] Processamento em background ja em andamento (fase: ${slaBackground.phase}).`);
        }

        if (dbTickets.length > 0) {
            const pad = n => String(n).padStart(2, '0');
            const processedAt =
                `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ` +
                `${pad(now.getHours())}:${pad(now.getMinutes())}`;

            return res.json({
                message: `SLA retornado do banco (${dbTickets.length} tickets). Recalculo em andamento.`,
                ticketCount: dbTickets.length,
                processedAt,
                team,
                cached: true,
                source: 'database',
                backgroundProcessing: slaBackground.isProcessing,
                tickets: dbTickets,
            });
        }

        // 3) Banco vazio e nenhum cache -> primeira execucao absoluta
        //    Nesse caso precisa esperar o background terminar
        console.log('[sla] Banco vazio e sem cache. Primeira execucao -- aguardando processamento...');

        // Esperar o background que ja foi disparado acima
        const waitStart = Date.now();
        const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min max
        while (slaBackground.isProcessing && (Date.now() - waitStart) < MAX_WAIT_MS) {
            await new Promise(r => setTimeout(r, 3000));
        }

        if (slaCache.response) {
            return res.json({ ...slaCache.response, cached: false });
        }

        return res.status(202).json({
            message: 'Processamento de SLA iniciado. Tente novamente em alguns minutos.',
            backgroundProcessing: true,
            phase: slaBackground.phase,
        });

    } catch (error) {
        console.error('[sla] Erro:', error.message);
        res.status(500).json({
            error: 'Erro interno no servidor',
            message: error.message
        });
    }
});

// ─── SLA Status ─────────────────────────────────────────────────
// GET /sla/status
//
// Retorna o estado atual do processamento de SLA em background.
// ────────────────────────────────────────────────────────────────
app.get('/sla/status', (req, res) => {
    const now = getNowBR();
    const cacheValid = slaCache.lastRun && (now - slaCache.lastRun) < CACHE_TTL_MS;
    const cacheAgeMin = slaCache.lastRun ? Math.round((now - slaCache.lastRun) / 1000 / 60) : null;

    res.json({
        backgroundProcessing: slaBackground.isProcessing,
        phase: slaBackground.phase,
        startedAt: slaBackground.startedAt,
        lastError: slaBackground.lastError,
        cache: {
            valid: cacheValid,
            lastRun: slaCache.lastRun,
            ageMinutes: cacheAgeMin,
            ticketCount: slaCache.response?.ticketCount || 0,
        },
    });
});

// ─── Ticket Notes (migrado da old-api) ────────────────────────
// CRUD de notas/mensagens internas associadas a tickets.
// Tabela: TICKETS (já existente no banco)
// ────────────────────────────────────────────────────────────────

// GET /ticket/:ticket — busca todas as notas de um ticket
app.get('/ticket/:ticket', async (req, res) => {
    const { ticket } = req.params;

    if (!ticket) {
        return res.status(400).json({ error: 'numero do ticket e obrigatorio' });
    }

    try {
        const rows = await getTicketNotes(ticket);
        res.json(rows);
    } catch (err) {
        console.error('[ticket-notes] Erro GET /ticket:', err.message);
        res.status(500).json({ error: 'Erro GET /ticket', message: err.message });
    }
});

// POST /ticket — cria uma nova nota em um ticket
app.post('/ticket', async (req, res) => {
    const { ticket, sender, message } = req.body;

    if (!ticket) {
        return res.status(400).json({ error: 'numero do ticket e obrigatorio' });
    }

    try {
        const row = await createTicketNote(ticket, sender, message);
        res.json(row);
    } catch (err) {
        console.error('[ticket-notes] Erro POST /ticket:', err.message);
        res.status(500).json({ error: 'Erro POST /ticket', message: err.message });
    }
});

// GET /alltickets — lista todos os ticket IDs que possuem notas
app.get('/alltickets', async (req, res) => {
    try {
        const tickets = await getAllTicketIds();
        res.json(tickets);
    } catch (err) {
        console.error('[ticket-notes] Erro GET /alltickets:', err.message);
        res.status(500).json({ error: 'Erro GET /alltickets', message: err.message });
    }
});

// Rota de health check
app.get('/', async (req, res) => {
    res.json({ message: 'Bot está rodando!' });
});

app.listen(PORT, async () => {
    // Executar migrations pendentes antes de aceitar requisicoes
    await initDB();

    console.log(`Bot rodando na porta ${PORT}`);
    console.log(`  GET  http://localhost:${PORT}/scrape-custom/:customSearchMenuId`);
    console.log(`  GET  http://localhost:${PORT}/tramites/:ticketId`);
    console.log(`  GET  http://localhost:${PORT}/visualizacoes/:ticketId`);
    console.log(`  POST http://localhost:${PORT}/sla`);
    console.log(`  GET  http://localhost:${PORT}/sla/status`);
    console.log(`  GET  http://localhost:${PORT}/ticket/:ticket`);
    console.log(`  POST http://localhost:${PORT}/ticket`);
    console.log(`  GET  http://localhost:${PORT}/alltickets`);
});