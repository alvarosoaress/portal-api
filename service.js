import sql from './db.js';

/**
 * Converte data BR (dd/mm/yyyy hh:mm ou dd/mm/yyyy hh:mm:ss) para Date.
 * Retorna null se o formato for invalido.
 */
function parseBRToDate(dateStr) {
    if (!dateStr || !dateStr.includes('/')) return null;

    const [datePart, timePart] = dateStr.split(' ');
    if (!datePart) return null;

    const [d, m, y] = datePart.split('/').map(Number);
    if (!d || !m || !y) return null;

    const timeParts = timePart ? timePart.split(':').map(Number) : [0, 0, 0];
    const hh = timeParts[0] || 0;
    const mm = timeParts[1] || 0;
    const ss = timeParts[2] || 0;

    return new Date(y, m - 1, d, hh, mm, ss);
}

/**
 * Faz upsert em batch dos snapshots de SLA na tabela sla_snapshots.
 *
 * Para cada ticket com SLA/VOC calculado:
 *   - Se ticket_id ja existe: atualiza todos os campos + updated_at
 *   - Se ticket_id nao existe: insere novo registro
 *
 * Tickets sem ticket_id (id = null) sao ignorados.
 *
 * @param {Array} tickets - Array de tickets com SLA/VOC calculado (saida de processTicketsSLA)
 * @param {Date} processedAt - Timestamp de quando a rota /sla foi executada
 * @returns {number} Quantidade de tickets persistidos
 */
export async function upsertSLASnapshots(tickets, processedAt) {
    // Filtrar tickets que tem ID valido
    const valid = tickets.filter(t => t.id != null);

    if (valid.length === 0) {
        console.log('[db] Nenhum ticket com ID valido para persistir.');
        return 0;
    }

    const rows = valid.map(t => ({
        ticket_id: parseInt(t.id, 10),
        number: t.number,
        title: t.title || null,
        client: t.client || null,
        module: t.module || null,
        group: t.group || null,
        person: t.person || null,
        responsible: t.responsible || null,
        team: t.team || null,
        opening: parseBRToDate(t.opening),
        last_update: parseBRToDate(t.lastUpdate),
        sla_minutes: t.slaMinutes,
        sla_formatted: t.slaFormatted || null,
        voc_minutes: t.vocMinutes,
        voc_formatted: t.vocFormatted || null,
        processed_at: processedAt,
        updated_at: new Date(),
    }));

    const BATCH_SIZE = 50;
    let persisted = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);

        await sql`
            INSERT INTO sla_snapshots ${sql(batch,
                'ticket_id', 'number', 'title', 'client', 'module',
                'group', 'person', 'responsible', 'team', 'opening', 'last_update',
                'sla_minutes', 'sla_formatted', 'voc_minutes', 'voc_formatted',
                'processed_at', 'updated_at'
            )}
            ON CONFLICT (ticket_id) DO UPDATE SET
                number        = EXCLUDED.number,
                title         = EXCLUDED.title,
                client        = EXCLUDED.client,
                module        = EXCLUDED.module,
                "group"       = EXCLUDED."group",
                person        = EXCLUDED.person,
                responsible   = EXCLUDED.responsible,
                team          = EXCLUDED.team,
                opening       = EXCLUDED.opening,
                last_update   = EXCLUDED.last_update,
                sla_minutes   = EXCLUDED.sla_minutes,
                sla_formatted = EXCLUDED.sla_formatted,
                voc_minutes   = EXCLUDED.voc_minutes,
                voc_formatted = EXCLUDED.voc_formatted,
                processed_at  = EXCLUDED.processed_at,
                updated_at    = EXCLUDED.updated_at
        `;

        persisted += batch.length;
    }

    console.log(`[db] ${persisted} tickets persistidos em sla_snapshots.`);
    return persisted;
}

/**
 * Busca todos os snapshots de SLA do banco.
 * Retorna os dados no mesmo formato que a rota POST /sla retornaria,
 * convertendo colunas snake_case para camelCase.
 *
 * @returns {Array} Array de tickets com SLA/VOC (formato identico ao processTicketsSLA)
 */
export async function getSLASnapshots() {
    const rows = await sql`
        SELECT
            ticket_id, number, title, client, module,
            "group", person, responsible, team,
            opening, last_update,
            sla_minutes, sla_formatted,
            voc_minutes, voc_formatted,
            processed_at
        FROM sla_snapshots
        ORDER BY sla_minutes DESC NULLS LAST
    `;

    return rows.map(r => {
        const fmtDate = (d) => {
            if (!d) return null;
            const dt = new Date(d);
            if (isNaN(dt)) return null;
            const pad = n => String(n).padStart(2, '0');
            return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
        };

        return {
            id: String(r.ticket_id),
            number: r.number,
            title: r.title,
            client: r.client,
            module: r.module,
            group: r.group,
            person: r.person,
            responsible: r.responsible,
            team: r.team,
            opening: fmtDate(r.opening),
            lastUpdate: fmtDate(r.last_update),
            slaMinutes: r.sla_minutes != null ? Number(r.sla_minutes) : null,
            slaFormatted: r.sla_formatted,
            vocMinutes: r.voc_minutes != null ? Number(r.voc_minutes) : null,
            vocFormatted: r.voc_formatted,
        };
    });
}
