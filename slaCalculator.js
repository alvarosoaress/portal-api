import { fetchTramites } from './tramites.js';

/**
 * Retorna a data/hora atual no fuso de Sao Paulo.
 */
function nowBrazil() {
    return new Date(
        new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })
    );
}

/**
 * Converte string de data BR (dd/mm/yyyy hh:mm ou dd/mm/yyyy hh:mm:ss)
 * para um objeto Date.
 */
function parseBRDateTime(dateString) {
    if (!dateString || !dateString.includes('/')) return null;

    const parts = dateString
        .replace(/\//g, ' ')
        .replace(':', ' ')
        .split(' ')
        .map(Number);

    // parts = [dd, mm, yyyy, hh, mm] ou [dd, mm, yyyy, hh, mm, ss] (se o replace so pega o primeiro :)
    // Melhor fazer split manual para suportar hh:mm:ss
    const [datePart, timePart] = dateString.split(' ');
    if (!datePart || !timePart) return null;

    const [d, m, y] = datePart.split('/').map(Number);
    const timeParts = timePart.split(':').map(Number);
    const hh = timeParts[0] || 0;
    const mm = timeParts[1] || 0;
    const ss = timeParts[2] || 0;

    return new Date(y, m - 1, d, hh, mm, ss);
}

/**
 * Calcula o tempo util (seg-sex 8h-18h) entre duas datas.
 * Retorna o total em minutos.
 */
function calculateBusinessTime(startDate, endDate) {
    if (!startDate || !endDate || endDate < startDate) return 0;

    const BUSINESS_START_HOUR = 8;
    const BUSINESS_END_HOUR = 18;

    let current = new Date(startDate);
    let totalMs = 0;

    while (current < endDate) {
        const weekday = current.getDay(); // 0 = Dom, 6 = Sab

        if (weekday >= 1 && weekday <= 5) {
            const dayStart = new Date(current);
            dayStart.setHours(BUSINESS_START_HOUR, 0, 0, 0);

            const dayEnd = new Date(current);
            dayEnd.setHours(BUSINESS_END_HOUR, 0, 0, 0);

            const effectiveStart = new Date(Math.max(dayStart, current));
            const effectiveEnd = new Date(Math.min(dayEnd, endDate));

            if (effectiveEnd > effectiveStart) {
                totalMs += effectiveEnd - effectiveStart;
            }
        }

        // Proximo dia 00:00
        current.setDate(current.getDate() + 1);
        current.setHours(0, 0, 0, 0);
    }

    return totalMs / 1000 / 60;
}

/**
 * Extrai o responsavel atual a partir do conteudo de um tramite.
 *
 * Padroes reconhecidos:
 *   - "assumido por NOME.SOBRENOME"  (abertura/assuncao)
 *   - "transferido de X para NOME.SOBRENOME"  (transferencia)
 *
 * Retorna o nome em UPPERCASE ou null se nao encontrar.
 */
function extractOwnerFromContent(content) {
    if (!content) return null;

    // "transferido de X para Y." — captura NOME.SOBRENOME (letras/numeros com pontos internos)
    const transferMatch = content.match(/transferido de .+ para ([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)/i);
    if (transferMatch) return transferMatch[1].toUpperCase();

    // "assumido por Y." — captura NOME.SOBRENOME
    const assumidoMatch = content.match(/assumido por ([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)/i);
    if (assumidoMatch) return assumidoMatch[1].toUpperCase();

    return null;
}

/**
 * Calcula o SLA de um ticket com base nos seus tramites.
 *
 * Os tramites chegam em ordem decrescente (mais recente primeiro) do parseTramites.
 * A funcao inverte para ordem cronologica e percorre sequencialmente.
 *
 * Logica:
 *   1. Rastrear o responsavel atual via padroes "assumido por NOME" e
 *      "transferido de X para NOME" no conteudo dos tramites.
 *   2. Para cada intervalo entre dois tramites consecutivos, contar tempo
 *      util (seg-sex 8h-18h) se:
 *        - O status do tramite anterior e "Em andamento"
 *        - O responsavel atual naquele momento e um membro do time
 *   3. Se o ultimo tramite (mais recente) tem status "Em andamento" e o
 *      responsavel atual e do time, conta tempo ate agora (fuso SP).
 *
 * @param {Array} tramites - Array de tramites no formato do parseTramites
 *   { author, origin, status, date, content, contentHtml }
 * @param {Array<string>} teamMembers - Nomes dos atendentes do time (uppercase)
 * @returns {number} Total de minutos de SLA
 */
function calculateSLA(tramites, teamMembers) {
    if (!tramites || tramites.length === 0) return 0;

    const teamSet = new Set(teamMembers.map(name => name.toUpperCase()));

    // Inverter para ordem cronologica (mais antigo primeiro)
    const sorted = [...tramites].reverse();

    let currentOwner = null;
    let totalTime = 0;

    for (let i = 0; i < sorted.length; i++) {
        const tramite = sorted[i];

        // Atualizar responsavel se este tramite contem "assumido por" ou "transferido para"
        const newOwner = extractOwnerFromContent(tramite.content);
        if (newOwner) {
            currentOwner = newOwner;
        }

        // Fallback: se nao ha owner explicito (ticket antigo sem "assumido por"),
        // usar o author do tramite de operador como responsavel
        const effectiveOwner = currentOwner
            || (tramite.origin === 'operador' && tramite.author
                ? tramite.author.toUpperCase()
                : null);

        // Contar tempo do intervalo entre este tramite e o proximo
        if (i < sorted.length - 1) {
            const next = sorted[i + 1];

            const isInProgress = tramite.status === 'Em andamento';
            const isTeamOwner = effectiveOwner && teamSet.has(effectiveOwner);

            if (isInProgress && isTeamOwner) {
                const startDate = parseBRDateTime(tramite.date);
                const endDate = parseBRDateTime(next.date);

                if (startDate && endDate) {
                    totalTime += calculateBusinessTime(startDate, endDate);
                }
            }
        } else {
            // Ultimo tramite (mais recente): se Em andamento e responsavel do time,
            // conta ate agora
            const isInProgress = tramite.status === 'Em andamento';
            const isTeamOwner = effectiveOwner && teamSet.has(effectiveOwner);

            if (isInProgress && isTeamOwner) {
                const startDate = parseBRDateTime(tramite.date);
                const now = nowBrazil();

                if (startDate) {
                    totalTime += calculateBusinessTime(startDate, now);
                }
            }
        }
    }

    return totalTime;
}

/**
 * Formata minutos em string legivel "Xh Ymin".
 */
function formatSLA(minutes) {
    if (minutes == null || isNaN(minutes)) return 'N/A';
    if (minutes === 0) return '0min';

    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);

    if (h === 0) return `${m}min`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}min`;
}

/**
 * Formata minutos em string legivel "Xd Yh" (dias e horas).
 * Usado para VOC que normalmente tem valores altos.
 */
function formatVOC(minutes) {
    if (minutes == null || isNaN(minutes)) return 'N/A';
    if (minutes === 0) return '0h';

    const totalHours = Math.floor(minutes / 60);
    const d = Math.floor(totalHours / 24);
    const h = totalHours % 24;

    if (d === 0) return `${h}h`;
    if (h === 0) return `${d}d`;
    return `${d}d ${h}h`;
}

/**
 * Extrai o ID numerico do ticket a partir do link.
 * Link formato: https://portaldocliente.praxio.com.br/Ticket/TicketPrincipal/905528
 */
function extractTicketId(link) {
    if (!link) return null;
    const parts = link.split('/');
    return parts[parts.length - 1] || null;
}

/**
 * Calcula o VOC (tempo corrido desde o ultimo tramite ate agora).
 *
 * Diferente do SLA, o VOC e tempo corrido simples — inclui noites,
 * fins de semana e feriados.
 *
 * @param {string} lastUpdate - Data do ultimo tramite no formato BR (dd/mm/yyyy hh:mm ou dd/mm/yyyy hh:mm:ss)
 * @returns {{ minutes: number|null, formatted: string }} Minutos corridos e string formatada
 */
function calculateVOC(lastUpdate) {
    const lastDate = parseBRDateTime(lastUpdate);
    if (!lastDate) {
        return { minutes: null, formatted: 'N/A' };
    }

    const now = nowBrazil();
    const diffMs = now - lastDate;

    if (diffMs < 0) {
        return { minutes: 0, formatted: '0min' };
    }

    const minutes = Math.round((diffMs / 1000 / 60) * 100) / 100;
    return { minutes, formatted: formatVOC(minutes) };
}

/**
 * Processa um batch de tickets buscando tramites e calculando SLA.
 * Usa concorrencia limitada para nao sobrecarregar o portal.
 *
 * @param {Array} tickets - Tickets retornados pelo scraper
 * @param {object} session - Axios session autenticada
 * @param {Function} loginFn - Funcao de login para re-autenticacao
 * @param {Array<string>} teamMembers - Nomes dos atendentes do time
 * @param {number} concurrency - Numero de tickets processados em paralelo (default 10)
 * @returns {Array} Tickets com SLA calculado
 */
export async function processTicketsSLA(tickets, session, loginFn, teamMembers, concurrency = 10) {
    const results = [];
    const BATCH_DELAY_MS = 2000;

    for (let i = 0; i < tickets.length; i += concurrency) {
        const batch = tickets.slice(i, i + concurrency);

        const batchResults = await Promise.all(
            batch.map(async (ticket) => {
                const ticketId = extractTicketId(ticket.link);

                if (!ticketId) {
                    console.warn(`[sla] Ticket ${ticket.number}: sem ID, pulando`);

                    const voc = calculateVOC(ticket.lastUpdate);

                    return {
                        id: null,
                        number: ticket.number,
                        title: ticket.title,
                        client: ticket.client,
                        module: ticket.module,
                        group: ticket.group,
                        person: ticket.person,
                        responsible: ticket.responsible,
                        team: ticket.team,
                        opening: ticket.opening,
                        lastUpdate: ticket.lastUpdate,
                        slaMinutes: null,
                        slaFormatted: 'Erro: sem ID',
                        vocMinutes: voc.minutes,
                        vocFormatted: voc.formatted,
                    };
                }

                try {
                    const result = await fetchTramites(ticketId, session, loginFn);
                    const slaMinutes = calculateSLA(result.tramites, teamMembers);

                    // Calcular VOC: tempo corrido (em minutos) desde o ultimo tramite ate agora
                    const voc = calculateVOC(ticket.lastUpdate);

                    return {
                        id: ticketId,
                        number: ticket.number,
                        title: ticket.title,
                        client: ticket.client,
                        module: ticket.module,
                        group: ticket.group,
                        person: ticket.person,
                        responsible: ticket.responsible,
                        team: ticket.team,
                        opening: ticket.opening,
                        lastUpdate: ticket.lastUpdate,
                        slaMinutes: Math.round(slaMinutes * 100) / 100,
                        slaFormatted: formatSLA(slaMinutes),
                        vocMinutes: voc.minutes,
                        vocFormatted: voc.formatted,
                    };
                } catch (err) {
                    console.error(`[sla] Erro ao processar ticket ${ticket.number} (ID ${ticketId}):`, err.message);

                    const voc = calculateVOC(ticket.lastUpdate);

                    return {
                        id: ticketId,
                        number: ticket.number,
                        title: ticket.title,
                        client: ticket.client,
                        module: ticket.module,
                        group: ticket.group,
                        person: ticket.person,
                        responsible: ticket.responsible,
                        team: ticket.team,
                        opening: ticket.opening,
                        lastUpdate: ticket.lastUpdate,
                        slaMinutes: null,
                        slaFormatted: 'Erro',
                        vocMinutes: voc.minutes,
                        vocFormatted: voc.formatted,
                    };
                }
            })
        );

        results.push(...batchResults);

        // Delay entre batches (exceto no ultimo)
        if (i + concurrency < tickets.length) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
        }
    }

    return results;
}
