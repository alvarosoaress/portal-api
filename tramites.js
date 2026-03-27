import { parse } from 'node-html-parser';

const BASE_URL = 'https://portaldocliente.praxio.com.br';

/**
 * Faz um GET autenticado com header X-Requested-With (AJAX).
 * Refaz login se a sessão tiver expirado.
 */
async function fetchAjax(session, loginFn, path, params = {}) {
    const url = `${BASE_URL}${path}`;
    const ajaxHeaders = {
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
    };

    let res = await session.get(url, { params, headers: ajaxHeaders });

    // Sessão expirou se recebemos uma página inteira (DOCTYPE) ou o form de login
    if (typeof res.data === 'string' && (
        res.data.includes('<!DOCTYPE html>') ||
        res.data.includes('name="txtLogin"')
    )) {
        console.log('[tramites] Sessão expirada, refazendo login...');
        await loginFn();

        res = await session.get(url, { params, headers: ajaxHeaders });

        if (typeof res.data === 'string' && res.data.includes('<!DOCTYPE html>')) {
            throw new Error('Sessão inválida mesmo após re-login');
        }
    }

    return res.data;
}

/**
 * Busca os trâmites de um ticket.
 *
 * Usa a rota AJAX `/Ticket/TicketTramitesHistorico` que o portal
 * chama internamente para renderizar o histórico.
 */
export async function fetchTramites(ticketId, session, loginFn) {
    const html = await fetchAjax(session, loginFn, '/Ticket/TicketTramitesHistorico', { idTicket: ticketId });
    return parseTramites(html, ticketId);
}

/**
 * Extrai os trâmites estruturados a partir do HTML retornado pelo portal.
 *
 * Estrutura do HTML:
 *  - Cada trâmite é um `div.itemdiv.dialogdiv`
 *  - Trâmite do operador (Praxio): div.body (sem body-right)
 *  - Trâmite do cliente:           div.body.body-right
 *  - Trâmite privado:              div.body.privado
 *  - Data/hora:  span.blue   dentro de div.time
 *  - Autor:      a           dentro de div.name
 *  - Conteúdo:   div.text.descricao
 *  - Status:     div.statusHistorico
 */
function parseTramites(html, ticketId) {
    const root = parse(html);
    const items = root.querySelectorAll('.itemdiv.dialogdiv');

    const tramites = items.map((item, index) => {
        const body = item.querySelector('.body');
        if (!body) return null;

        // Tipo do trâmite
        const isPrivate = body.classList.contains('privado');
        const isClient = body.classList.contains('body-right');
        let origin = 'operador';
        if (isClient) origin = 'cliente';
        if (isPrivate) origin = 'privado';

        // Data
        const timeEl = body.querySelector('.time span.blue');
        const dateStr = timeEl ? timeEl.text.trim() : null;

        // Autor
        const nameEl = body.querySelector('.name a');
        let author = nameEl ? nameEl.text.trim() : null;

        // Remove sufixo " (Privado)" do nome se existir
        if (author && author.endsWith('(Privado)')) {
            author = author.replace(/\s*\(Privado\)\s*$/, '').trim();
        }

        // Conteúdo (HTML e texto puro)
        const contentEl = body.querySelector('.text.descricao');
        const contentHtml = contentEl ? contentEl.innerHTML.trim() : '';
        const contentText = contentEl ? contentEl.text.trim() : '';

        // Status
        const statusEl = body.querySelector('.statusHistorico');
        let status = statusEl ? statusEl.text.trim() : null;
        if (status) {
            status = status.replace(/^Status:\s*/i, '');
        }

        return {
            index,
            date: dateStr,
            author,
            origin,
            status,
            content: contentText,
            contentHtml,
        };
    }).filter(Boolean);

    return {
        ticketId,
        total: tramites.length,
        tramites,
    };
}
