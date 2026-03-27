import sql from './db.js';

/**
 * Busca todas as notas/mensagens de um ticket específico.
 * @param {string} ticket - Número/identificador do ticket
 * @returns {Array} Rows da tabela TICKETS onde ticket = $1
 */
export async function getTicketNotes(ticket) {
    const rows = await sql`SELECT * FROM tickets WHERE ticket = ${ticket}`;
    return rows;
}

/**
 * Insere uma nova nota/mensagem em um ticket.
 * @param {string} ticket - Número/identificador do ticket
 * @param {string} sender - Quem enviou a mensagem
 * @param {string} message - Conteúdo da mensagem
 * @returns {object} Row inserida
 */
export async function createTicketNote(ticket, sender, message) {
    const [row] = await sql`
        INSERT INTO tickets (message, sender, ticket)
        VALUES (${message}, ${sender}, ${ticket})
        RETURNING *
    `;
    return row;
}

/**
 * Lista todos os ticket IDs que possuem notas.
 * @returns {Array<string>} Array de ticket identifiers
 */
export async function getAllTicketIds() {
    const rows = await sql`SELECT ticket FROM tickets`;
    return rows.map(row => row.ticket);
}
