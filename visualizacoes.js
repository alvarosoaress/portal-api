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
        console.log('[visualizacoes] Sessão expirada, refazendo login...');
        await loginFn();

        res = await session.get(url, { params, headers: ajaxHeaders });

        if (typeof res.data === 'string' && res.data.includes('<!DOCTYPE html>')) {
            throw new Error('Sessão inválida mesmo após re-login');
        }
    }

    return res.data;
}

/**
 * Busca quem visualizou um ticket.
 *
 * Usa a rota AJAX `/Ticket/VisualizadoPor`.
 */
export async function fetchVisualizacoes(ticketId, session, loginFn) {
    const html = await fetchAjax(session, loginFn, '/Ticket/VisualizadoPor', { id_ticket: ticketId });
    return parseVisualizacoes(html, ticketId);
}

/**
 * Extrai as visualizações a partir do HTML retornado pelo portal.
 *
 * Estrutura:
 *  <table class="table">
 *    <tr>
 *      <td>USUARIO</td>
 *      <td>dd/mm/aaaa hh:mm:ss</td>
 *    </tr>
 */
function parseVisualizacoes(html, ticketId) {
    const root = parse(html);
    const rows = root.querySelectorAll('tbody tr');

    const visualizacoes = rows.map(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return null;

        const usuario = cells[0].text.trim();
        const dataStr = cells[1].text.trim();

        if (!usuario || !dataStr) return null;

        return { usuario, data: dataStr };
    }).filter(Boolean);

    return {
        ticketId,
        total: visualizacoes.length,
        visualizacoes,
    };
}
