import { parse } from 'node-html-parser';

const BASE_URL = 'https://portaldocliente.praxio.com.br';
const FILTER_URL = `${BASE_URL}/Ticket/ObterListaFiltro`;
const PAGINATION_URL = `${BASE_URL}/Ticket/ObterListaPaginacao`;

// Delay entre páginas para não sobrecarregar o portal (ms)
const PAGE_DELAY_MS = 2000;

// Limite de 2 meses para trás (usado apenas em fetchAllTickets, não em fetchCustomSearchTickets)
const MAX_AGE_MONTHS = 2;

// Headers que o portal DevExpress espera
const DX_HEADERS = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'Accept': 'text/html, */*; q=0.01',
    'Referer': `${BASE_URL}/Ticket`,
    'Origin': BASE_URL,
    'DXCss': '/Content/Shared/charts-graphs.css,/Content/Shared/clockface.css,/Content/Shared/fullcalendar.css,/Content/Shared/select2.css,/Content/Shared/theme.css,/Content/Shared/timepicker.css,/Content/Shared/dataTables.min.css,/Content/Shared/dataTables.colVis.css,/Content/Shared/fixedColumns.dataTables.min.css,/Content/Shared/chosen.css,/Content/Layout/css/bootstrap.css,/Content/Layout/css/font-awesome.css,/Content/Layout/css/styleBGM.css,/Content/Layout/css/jquery.gritter.css,/Content/Layout/css/ace-fonts.css,/Content/Layout/css/dropzone.css,/Content/Layout/css/ace.css,/Content/toastr.css,0_1791,1_33,0_1793,0_5726,1_29,0_1654,1_18,0_1656,0_1658,0_1660,1_19,1_3,1_17,1_16,1_22,1_21,/Content/Shared/main.css,/Content/powertour.3.0.0.css,/Content/powertour-style-clean.min.css,/Content/animate.min.css,/Content/powertour-connectors.min.css',
    'DXScript': '1_186,1_184,1_185,1_183,1_231,1_168,1_134,1_131,1_206,1_219,1_213,1_216,1_133,14_39,14_3,1_212,1_137,14_8,1_224,1_150,14_10,1_214,1_152,1_151,14_11,1_166,1_174,1_229,1_193,1_195,1_230,1_178,14_12,1_223,1_222,1_205,14_38,1_138,1_179,1_217,1_215,1_153,1_226,1_192,1_190,1_196,14_15,14_17,1_198,1_199,14_19,1_200,1_201,14_20,14_21,1_180,14_14,1_203,1_207,14_24,1_220,14_26,1_218,1_221,14_30,1_225,14_34,14_37,1_155,14_1,1_165,1_194,14_16,1_163,1_169,1_164,1_156,1_158',
};

/**
 * Carrega a página /Ticket para inicializar o grid no servidor
 * e extrai os estados (callbackState e customOperationState) do HTML.
 * 
 * @param {object} session - Instância do axios com cookies (sessão autenticada)
 * @returns {object} - { callbackState, customOperationState }
 */
export async function initializeGridState(session) {
    console.log('📦 Carregando /Ticket para inicializar o grid no servidor...');
    const res = await session.get(`${BASE_URL}/Ticket`);

    if (!res || res.status !== 200) {
        throw new Error(`Falha ao carregar /Ticket: status ${res?.status}`);
    }

    const html = res.data;
    console.log(`   Página /Ticket carregada (${html.length} chars)`);

    // Extrair callbackState do JSON embutido no HTML
    const csMatch = html.match(/callbackState':'([A-Za-z0-9+/=]+)'/);
    if (!csMatch) {
        throw new Error('Não foi possível extrair callbackState do HTML');
    }

    // Extrair customOperationState do JSON embutido no HTML
    const cosMatch = html.match(/customOperationState':'([A-Za-z0-9+/=]+)'/);
    if (!cosMatch) {
        throw new Error('Não foi possível extrair customOperationState do HTML');
    }

    const callbackState = csMatch[1];
    const customOperationState = cosMatch[1];

    console.log(`   callbackState extraído (${callbackState.length} chars)`);
    console.log(`   customOperationState extraído (${customOperationState.length} chars)`);

    // Extrair os IDs (keys) dos tickets que já estão sendo exibidos na página inicial
    // O DevExpress precisa desses IDs no estado do grid para fazer o callback corretamente
    const keysMatch = html.match(/keys':\[([^\]]*)\]/);
    let initialKeys = [];
    if (keysMatch && keysMatch[1]) {
        initialKeys = keysMatch[1].replace(/'/g, '').split(',').map(k => k.trim()).filter(k => k);
        console.log(`   ${initialKeys.length} keys iniciais extraídas do grid`);
    } else {
        console.log('   ⚠️ Nenhuma key inicial encontrada no HTML do grid');
    }

    return { callbackState, customOperationState, initialKeys };
}

/**
 * Extrai callbackState, customOperationState e keys de uma resposta HTML do DevExpress.
 * Usado após cada step do callback para obter o estado atualizado do grid.
 */
function extractStateFromResponse(html, stepName) {
    const csMatch = html.match(/callbackState':'([A-Za-z0-9+/=]+)'/);
    if (!csMatch) {
        throw new Error(`${stepName}: não foi possível extrair callbackState da resposta`);
    }

    const cosMatch = html.match(/customOperationState':'([A-Za-z0-9+/=]+)'/);
    if (!cosMatch) {
        throw new Error(`${stepName}: não foi possível extrair customOperationState da resposta`);
    }

    const keysMatch = html.match(/keys':\[([^\]]*)\]/);
    let keys = [];
    if (keysMatch && keysMatch[1]) {
        keys = keysMatch[1].replace(/'/g, '').split(',').map(k => k.trim()).filter(k => k);
    }

    return {
        callbackState: csMatch[1],
        customOperationState: cosMatch[1],
        keys,
    };
}

/**
 * Monta o DXCallbackArgument genérico para qualquer comando de callback.
 * Formato: c0:KV|{len};[...ids];FR|2;-1;CR|2;{};GB|{len};{command};
 */
function buildCallbackArgument(command, currentKeys) {
    const idsStr = '[' + currentKeys.map(id => `"${id}"`).join(',') + ']';
    const kvLength = idsStr.length;
    const gbLength = command.length;
    return `c0:KV|${kvLength};${idsStr};FR|2;-1;CR|2;{};GB|${gbLength};${command};`;
}

/**
 * Executa um step de callback no grid DevExpress.
 * Monta o body, posta para a URL adequada, e retorna o estado extraído da resposta.
 * 
 * @param {object} session - Instância do axios com cookies
 * @param {string} url - URL do endpoint (ObterListaFiltro, ObterListaPaginacao, ou ObterListaOrdenacao)
 * @param {string} command - Comando DevExpress (ex: "17|APPLYCOLUMNFILTER2|270|;")
 * @param {string} callbackState - callbackState atual
 * @param {string} customOperationState - customOperationState atual
 * @param {string[]} currentKeys - IDs dos tickets exibidos atualmente
 * @param {object} extraFields - Campos extras do form para este step específico
 * @param {string} stepName - Nome descritivo do step (para logs)
 * @returns {object} - { callbackState, customOperationState, keys, html }
 */
async function executeGridCallback(session, url, command, callbackState, customOperationState, currentKeys, extraFields = {}, stepName = 'step') {
    console.log(`   [${stepName}] Executando callback: ${command.substring(0, 60)}...`);

    const dxCallbackArg = buildCallbackArgument(command, currentKeys);
    console.log(`   [${stepName}] DXCallbackArgument: ${dxCallbackArg.substring(0, 120)}...`);
    console.log(`   [${stepName}] URL: ${url}`);
    const gridState = buildGridState(callbackState, customOperationState, currentKeys);

    const params = new URLSearchParams();
    params.set('DXCallbackName', 'grdTicket');
    params.set('DXCallbackArgument', dxCallbackArg);
    params.set('grdTicket', gridState);

    // Campos fixos do formulário
    const formFields = buildFormFields();
    for (const [key, value] of Object.entries(formFields)) {
        params.set(key, value);
    }

    // Campos extras específicos deste step (sobrescrevem os fixos se necessário)
    for (const [key, value] of Object.entries(extraFields)) {
        params.set(key, value);
    }

    const response = await session.post(url, params, {
        headers: DX_HEADERS,
    });

    if (!response || response.status !== 200) {
        throw new Error(`${stepName}: falha com status ${response?.status}`);
    }

    const html = response.data;
    console.log(`   [${stepName}] Resposta recebida (${html.length} chars)`);

    if (html.length < 100) {
        console.log(html)
        throw new Error(`${stepName}: resposta muito curta (${html.length} chars) - comando pode estar incorreto`);
    }

    const state = extractStateFromResponse(html, stepName);
    console.log(`   [${stepName}] Estado extraído: ${state.keys.length} keys, callbackState ${state.callbackState.length} chars`);

    return { ...state, html };
}

/**
 * Configura todos os filtros do grid DevExpress replicando a sequência exata do browser.
 * São 3 steps que devem ser executados em ordem, cada um usando o estado retornado pelo anterior.
 * 
 * Sequência:
 * 1. Aplica filtro de cliente na FilterRow (APPLYCOLUMNFILTER1 col17 valor clientName) -> ObterListaFiltro
 * 2. Remove filtro GrupoTipo (APPLYCOLUMNFILTER2 col17 valor 270) -> ObterListaFiltro
 * 3. Aplica filtro de Status no header (APPLYHEADERCOLUMNFILTER1 col23) -> ObterListaFiltro
 * 
 * Após os 3 steps, o grid já retorna a primeira página com 50 tickets filtrados.
 * A paginação segue com PAGERONCLICK3|PBN para ObterListaPaginacao.
 * 
 * @param {object} session - Instância do axios com cookies
 * @param {string} clientName - Nome do cliente para filtrar
 * @param {string} callbackState - callbackState inicial extraído do HTML
 * @param {string} customOperationState - customOperationState inicial
 * @param {string[]} initialKeys - IDs dos tickets da página inicial
 * @returns {object} - { callbackState, customOperationState, keys, firstPageTickets }
 */
async function setupGridFilters(session, clientName, callbackState, customOperationState, initialKeys) {
    console.log(`🔧 Configurando grid com filtros (3 steps)...`);

    let cs = callbackState;
    let cos = customOperationState;
    let keys = initialKeys;

    // ─── Step 1: Apply client name filter in FilterRow ───
    // DXCallbackArgument command: 17|APPLYCOLUMNFILTER1|{70+len}|{clientName}
    // The inner parameter = 70 + clientName.length (DevExpress internal offset)
    // grdTicket$DXFREditorcol7 = clientName
    // grdTicket$DXFREditorcol27 = Desenvolvimento (col27_VI=4, DDD$L=4)
    // Posts to ObterListaFiltro
    const step1Command = `17|APPLYCOLUMNFILTER1|${70 + clientName.length}|${clientName}`;
    const step1 = await executeGridCallback(
        session,
        FILTER_URL,
        step1Command,
        cs, cos, keys,
        {
            'grdTicket$DXFREditorcol7': clientName,
            'grdTicket_DXFREditorcol27_VI': '4',
            'grdTicket$DXFREditorcol27': 'Desenvolvimento',
            'grdTicket$DXFREditorcol27$DDD$L': '4',
        },
        'Step1-ClientFilter'
    );
    cs = step1.callbackState;
    cos = step1.customOperationState;
    keys = step1.keys;

    // ─── Step 2: Remove GrupoTipo filter ───
    // DXCallbackArgument command: 17|APPLYCOLUMNFILTER2|270|
    // col27 is now cleared, col27$DDDState changes windowsState
    // Posts to ObterListaFiltro
    const step2 = await executeGridCallback(
        session,
        FILTER_URL,
        '17|APPLYCOLUMNFILTER2|270|',
        cs, cos, keys,
        {
            'grdTicket$DXFREditorcol7': clientName,
            'grdTicket_DXFREditorcol27_VI': '',
            'grdTicket$DXFREditorcol27': '',
            'grdTicket$DXFREditorcol27$DDDState': '{"windowsState":"0:0:-1:0:0:1:114:119:1:0:0:0"}',
            'grdTicket$DXFREditorcol27$DDD$L': '',
        },
        'Step2-RemoveGrupoTipo'
    );
    cs = step2.callbackState;
    cos = step2.customOperationState;
    keys = step2.keys;

    // ─── Step 3: Apply Status header column filter (all statuses) ───
    // DXCallbackArgument command: 23|APPLYHEADERCOLUMNFILTER1|436|["!1","!3","!4","!5","!6","!7","!8"]
    // 436 = 400 + length of filter value (36 chars) - DevExpress internal offset
    // This step requires additional form fields for the header filter popup
    // Posts to ObterListaFiltro
    const statusFilterValue = '["!1","!3","!4","!5","!6","!7","!8"]';
    const step3Command = `23|APPLYHEADERCOLUMNFILTER1|${400 + statusFilterValue.length}|${statusFilterValue}`;
    const step3 = await executeGridCallback(
        session,
        FILTER_URL,
        step3Command,
        cs, cos, keys,
        {
            'grdTicket$DXFREditorcol7': clientName,
            'grdTicket$HFSACheckBox': 'C',
            'grdTicket$HFListBox$State': '{"CustomCallback":""}',
            'grdTicket$HFListBox': '2|!12|!32|!42|!52|!62|!72|!8',
            'grdTicket$DXHFPState': '{"windowsState":"0:0:-1:803:186:1:180:200:1:0:0:0"}',
        },
        'Step3-StatusFilter'
    );
    cs = step3.callbackState;
    cos = step3.customOperationState;
    keys = step3.keys;

    // The status filter response contains the first page of properly filtered data (50 tickets)
    const firstPageTickets = parseTicketsFromHTML(step3.html);
    console.log(`✅ Grid configurado! ${firstPageTickets.length} tickets na primeira página, ${keys.length} keys`);

    return {
        callbackState: cs,
        customOperationState: cos,
        keys,
        firstPageTickets,
    };
}

/**
 * Gera a data atual no formato MM/dd/yyyy para os campos visibleDate do DevExpress
 */
function getCurrentVisibleDate() {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
}

// Template dos campos fixos do formulário DevExpress
function buildFormFields() {
    const visibleDate = getCurrentVisibleDate();
    return {
        'grdTicket_DXFREditorcol16_VI': '',
        'grdTicket$DXFREditorcol16': '',
        'grdTicket$DXFREditorcol16$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol16$DDD$L$State': '{"CustomCallback":""}',
        'grdTicket$DXFREditorcol16$DDD$L': '',
        'grdTicket$DXFREditorcol0': '',
        'grdTicket$DXFREditorcol1': '',
        'grdTicket_DXFREditorcol4_VI': '',
        'grdTicket$DXFREditorcol4': '',
        'grdTicket$DXFREditorcol4$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol4$DDD$L$State': '{"CustomCallback":""}',
        'grdTicket$DXFREditorcol4$DDD$L': '',
        'grdTicket_DXFREditorcol5_VI': '',
        'grdTicket$DXFREditorcol5': '',
        'grdTicket$DXFREditorcol5$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol5$DDD$L$State': '{"CustomCallback":""}',
        'grdTicket$DXFREditorcol5$DDD$L': '',
        'grdTicket$DXFREditorcol14$State': '{"rawValue":"N"}',
        'grdTicket$DXFREditorcol14': '',
        'grdTicket$DXFREditorcol14$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol14$DDD$C': `{"visibleDate":"${visibleDate}"}`,
        'grdTicket$DXFREditorcol14$DDD$C$FNPState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol6$State': '{"rawValue":"N"}',
        'grdTicket$DXFREditorcol6': '',
        'grdTicket$DXFREditorcol6$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol6$DDD$C': `{"visibleDate":"${visibleDate}"}`,
        'grdTicket$DXFREditorcol6$DDD$C$FNPState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol13': '',
        'grdTicket_DXFREditorcol10_VI': '',
        'grdTicket$DXFREditorcol10': '',
        'grdTicket$DXFREditorcol10$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol10$DDD$L$State': '{"CustomCallback":""}',
        'grdTicket$DXFREditorcol10$DDD$L': '',
        'grdTicket$DXFREditorcol30$State': '{"rawValue":"N"}',
        'grdTicket$DXFREditorcol30': '',
        'grdTicket$DXFREditorcol30$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol30$DDD$C': `{"visibleDate":"${visibleDate}"}`,
        'grdTicket$DXFREditorcol30$DDD$C$FNPState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket_DXFREditorcol3_VI': '',
        'grdTicket$DXFREditorcol3': '',
        'grdTicket$DXFREditorcol3$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol3$DDD$L$State': '{"CustomCallback":""}',
        'grdTicket$DXFREditorcol3$DDD$L': '',
        'grdTicket$DXFREditorcol11': '',
        'grdTicket_DXFREditorcol19_VI': '',
        'grdTicket$DXFREditorcol19': '',
        'grdTicket$DXFREditorcol19$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol19$DDD$L$State': '{"CustomCallback":""}',
        'grdTicket$DXFREditorcol19$DDD$L': '',
        'grdTicket_DXFREditorcol27_VI': '',
        'grdTicket$DXFREditorcol27': '',
        'grdTicket$DXFREditorcol27$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol27$DDD$L$State': '{"CustomCallback":""}',
        'grdTicket$DXFREditorcol27$DDD$L': '',
        'grdTicket$DXFREditorcol28': '',
        'grdTicket$DXFREditorcol29': '',
        'grdTicket$DXFREditorcol8': '',
        'grdTicket$DXFREditorcol15$State': '{"rawValue":"N"}',
        'grdTicket$DXFREditorcol15': '',
        'grdTicket$DXFREditorcol15$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol15$DDD$C': `{"visibleDate":"${visibleDate}"}`,
        'grdTicket$DXFREditorcol15$DDD$C$FNPState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol9': '',
        'grdTicket_DXFREditorcol31_VI': '',
        'grdTicket$DXFREditorcol31': '',
        'grdTicket$DXFREditorcol31$DDDState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXFREditorcol31$DDD$L$State': '{"CustomCallback":""}',
        'grdTicket$DXFREditorcol31$DDD$L': '',
        'grdTicket$custwindowState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXHFPState': '{"windowsState":"0:0:-1:0:0:0:-10000:-10000:1:0:0:0"}',
        'grdTicket$DXHFP$TPCFCm1$O': 'OK',
        'grdTicket$DXHFP$TPCFCm1$C': 'Cancel',
        'grdTicket$DXFilterRowMenu': '{"selectedItemIndexPath":"","checkedState":""}',
        'grdTicket$DXPagerBottom$PSP': '{"selectedItemIndexPath":"2","checkedState":""}',
        'filter': '\n                        Pendente Praxio\n                        \n                    ',
    };
}

/**
 * Converte data no formato BR (dd/mm/yyyy hh:mm) para Date object
 */
export function parseBRDate(str) {
    const [d, m, rest] = str.split('/');
    const [y, time] = rest.split(' ');
    return new Date(`${y}-${m}-${d} ${time}`);
}

/**
 * Extrai tickets do HTML retornado pelo grid DevExpress
 */
export function parseTicketsFromHTML(htmlString) {
    try {
        const tickets = [];
        const document = parse(htmlString);
        const ticketsDOM = document.querySelectorAll('.dxgvDataRow_Metropolis');

        ticketsDOM.forEach((ticket) => {
            const responsibleRaw = ticket.childNodes[8].innerText.trim();
            // Formato: "VITOR.OLIVEIRA (N1)" ou "VITOR.OLIVEIRA"
            const responsibleMatch = responsibleRaw.match(/^(.+?)\s*\(.*\)$/);
            const responsible = responsibleMatch ? responsibleMatch[1].trim() : responsibleRaw;

            let team = responsibleRaw.split(' ');
            const openingStr = ticket.childNodes[7].innerText.trim();
            const lastUpdateStr = ticket.childNodes[6].innerText.trim();

            // Extrair link: pode ser <a href="/Ticket/TicketPrincipal/ID"> ou texto com slice
            const aTag = ticket.childNodes[2].querySelector('a');
            let link;
            if (aTag) {
                link = `${BASE_URL}${aTag.getAttribute('href')}`;
            } else {
                link = `${BASE_URL}/Ticket/TicketPrincipal/` + ticket.childNodes[2].innerHTML.slice(33, 39);
            }

            // Parsear datas de forma segura (podem vir como &nbsp; ou vazio)
            let openingDate = null;
            let lastUpdateDate = null;
            try {
                if (openingStr && openingStr !== '&nbsp;' && openingStr.includes('/')) {
                    openingDate = parseBRDate(openingStr);
                }
            } catch (_) { /* data inválida, manter null */ }
            try {
                if (lastUpdateStr && lastUpdateStr !== '&nbsp;' && lastUpdateStr.includes('/')) {
                    lastUpdateDate = parseBRDate(lastUpdateStr);
                }
            } catch (_) { /* data inválida, manter null */ }

            tickets.push({
                number: ticket.childNodes[2].innerText,
                link,
                title: ticket.childNodes[3].innerText,
                opening: openingStr,
                openingDate,
                lastUpdate: lastUpdateStr,
                lastUpdateDate,
                team: team[team.length - 1],
                responsible,
                group: ticket.childNodes[14] ? ticket.childNodes[14].innerText.trim() : '',
                client: ticket.childNodes[9].innerText.slice('&', -6),
                module: ticket.childNodes[10].innerText.slice('&', -6),
                person: ticket.childNodes[12].innerText.slice('&', -6)
            });
        });

        return tickets;
    } catch (error) {
        console.error('Erro ao fazer parse dos tickets:', error.message);
        return [];
    }
}

/**
 * Monta o DXCallbackArgument para paginação (próxima página).
 * Usa PAGERONCLICK3|PBN (Page Button Next) para avançar uma página.
 * 
 * Formato: c0:KV|{kvLength};[...ids];FR|2;-1;CR|2;{};GB|20;12|PAGERONCLICK3|PBN;
 */
function buildDXCallbackArgument(previousTicketIds = []) {
    const idsStr = '[' + previousTicketIds.map(id => `"${id}"`).join(',') + ']';
    const kvLength = idsStr.length;

    const pagerCmd = '12|PAGERONCLICK3|PBN';
    const gbLength = pagerCmd.length;

    return `c0:KV|${kvLength};${idsStr};FR|2;-1;CR|2;{};GB|${gbLength};${pagerCmd};`;
}

/**
 * Monta o campo grdTicket (estado JSON do grid serializado com &quot;)
 */
function buildGridState(callbackState, customOperationState, previousTicketIds = []) {
    const state = {
        focusedRow: -1,
        keys: previousTicketIds,
        resizingState: '{}',
        callbackState: callbackState,
        lastMultiSelectIndex: -1,
        scrollState: [0, 0],
        selection: '',
        customOperationState: customOperationState,
    };

    // O DevExpress espera o JSON com &quot; no lugar de "
    return JSON.stringify(state).replace(/"/g, '&quot;');
}

/**
 * Monta o body completo da requisição de paginação usando URLSearchParams.
 * Usa PAGERONCLICK3|PBN (Page Button Next) para avançar para a próxima página.
 */
function buildRequestBody(clientName, callbackState, customOperationState, previousTicketIds = []) {
    const params = new URLSearchParams();

    params.set('DXCallbackName', 'grdTicket');
    params.set('DXCallbackArgument', buildDXCallbackArgument(previousTicketIds));
    params.set('grdTicket', buildGridState(callbackState, customOperationState, previousTicketIds));

    // Campo do filtro de cliente
    params.set('grdTicket$DXFREditorcol7', clientName);

    // Todos os campos fixos do formulário (com visibleDate dinâmico)
    const formFields = buildFormFields();
    for (const [key, value] of Object.entries(formFields)) {
        params.set(key, value);
    }

    return params;
}

/**
 * Calcula a data limite (N meses atrás a partir de hoje)
 */
function getDateLimit() {
    const now = new Date();
    now.setMonth(now.getMonth() - MAX_AGE_MONTHS);
    return now;
}

/**
 * Pausa a execução por um tempo determinado
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Monta o body completo da requisição de paginação para customSearchMenu.
 * Similar ao buildRequestBody, mas inclui customSearchMenu e não força filtro de cliente.
 */
function buildCustomSearchRequestBody(customSearchMenuId, callbackState, customOperationState, previousTicketIds) {
    const params = new URLSearchParams();

    params.set('DXCallbackName', 'grdTicket');
    params.set('DXCallbackArgument', buildDXCallbackArgument(previousTicketIds));
    params.set('grdTicket', buildGridState(callbackState, customOperationState, previousTicketIds));

    // Todos os campos fixos do formulário
    const formFields = buildFormFields();
    for (const [key, value] of Object.entries(formFields)) {
        params.set(key, value);
    }

    // customSearchMenu identifica a busca salva no portal
    params.set('customSearchMenu', customSearchMenuId);

    return params;
}

/**
 * Busca todos os tickets de uma busca salva (customSearchMenu) no portal.
 * 
 * Fluxo:
 * 1. POST para /Ticket/indexPartial com customSearchmenu={id} para obter a primeira página já filtrada
 * 2. Extrair callbackState, customOperationState e keys da resposta
 * 3. Paginar com PAGERONCLICK3|PBN para ObterListaPaginacao
 * 4. Para quando não há mais páginas (keys duplicadas, generalError, ou 0 tickets)
 * 
 * @param {string} customSearchMenuId - ID da busca salva no portal (ex: "28660")
 * @param {object} session - Instância do axios com cookies (sessão autenticada)
 * @param {function} loginFn - Função de login para re-autenticar se sessão expirar
 * @returns {Array} - Array com todos os tickets coletados
 */
export async function fetchCustomSearchTickets(customSearchMenuId, session, loginFn) {
    const allTickets = [];
    const maxPages = 100;
    const maxRetries = 2;

    console.log(`📋 Iniciando coleta via customSearchMenu=${customSearchMenuId}`);

    // Passo 1: Carregar a primeira página via indexPartial com o customSearchMenu
    let firstPageHtml;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            console.log('📦 Carregando primeira página via indexPartial...');
            const res = await session.post(
                `${BASE_URL}/Ticket/indexPartial`,
                new URLSearchParams({ customSearchmenu: customSearchMenuId }),
                { headers: DX_HEADERS }
            );

            if (!res || res.status !== 200) {
                throw new Error(`indexPartial retornou status ${res?.status}`);
            }

            if (res.data.length < 500) {
                if (attempt < maxRetries && loginFn) {
                    console.log(`⚠️ Resposta curta (${res.data.length} chars) - tentando re-login (tentativa ${attempt + 1})...`);
                    await loginFn();
                    await sleep(1000);
                    continue;
                }
                throw new Error(`Resposta muito curta (${res.data.length} chars) - sessão possivelmente expirada`);
            }

            firstPageHtml = res.data;
            console.log(`   Primeira página recebida (${firstPageHtml.length} chars)`);
            break;
        } catch (error) {
            if (attempt < maxRetries && loginFn) {
                console.log(`⚠️ Erro: ${error.message} - tentando re-login (tentativa ${attempt + 1})...`);
                await loginFn();
                await sleep(1000);
                continue;
            }
            throw error;
        }
    }

    // Parse da primeira página
    const firstPageTickets = parseTicketsFromHTML(firstPageHtml);
    if (firstPageTickets.length === 0) {
        console.log(`✅ Nenhum ticket encontrado para customSearchMenu=${customSearchMenuId}`);
        return [];
    }

    // Extrair estado do grid da primeira página
    let currentCallbackState, currentCustomOperationState, previousTicketIds;
    try {
        const state = extractStateFromResponse(firstPageHtml, 'indexPartial');
        currentCallbackState = state.callbackState;
        currentCustomOperationState = state.customOperationState;
        previousTicketIds = state.keys.length > 0 ? state.keys : firstPageTickets.map(t => t.number.trim());
        console.log(`   Estado extraído: ${previousTicketIds.length} keys, callbackState ${currentCallbackState.length} chars`);
    } catch (e) {
        console.log(`   ⚠️ Não foi possível extrair estado da primeira página: ${e.message}`);
        // Sem estado, não conseguimos paginar — retornar só a primeira página
        console.log(`✅ Retornando apenas primeira página: ${firstPageTickets.length} tickets`);
        return firstPageTickets;
    }

    // Adicionar tickets da primeira página
    const seenTicketIds = new Set();
    for (const t of firstPageTickets) {
        const id = t.link ? t.link.match(/TicketPrincipal\/(\d+)/)?.[1] : t.number.trim();
        if (id) seenTicketIds.add(id);
    }
    allTickets.push(...firstPageTickets);
    console.log(`   ${allTickets.length} tickets coletados da página 1`);

    // Passo 2: Paginar com PBN
    for (let page = 1; page < maxPages; page++) {
        console.log(`📄 Buscando página ${page + 1} (PBN)...`);

        let response = null;
        let success = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const body = buildCustomSearchRequestBody(
                    customSearchMenuId,
                    currentCallbackState,
                    currentCustomOperationState,
                    previousTicketIds
                );

                response = await session.post(PAGINATION_URL, body, {
                    headers: DX_HEADERS,
                });

                if (!response || response.status !== 200) {
                    console.error(`❌ Erro na página ${page + 1}: status ${response?.status}`);
                    break;
                }

                if (response.data.includes("{'generalError':''}")) {
                    console.log(`✅ Página ${page + 1}: generalError - fim da paginação`);
                    success = false;
                    break;
                }

                if (response.data.length < 500) {
                    if (attempt < maxRetries && loginFn) {
                        console.log(`⚠️ Resposta curta na página ${page + 1} (${response.data.length} chars) - tentando re-login (tentativa ${attempt + 1})...`);
                        await loginFn();
                        await sleep(1000);
                        continue;
                    }
                    console.log(`⚠️ Resposta muito curta na página ${page + 1} (${response.data.length} chars) - sessão expirada e re-login falhou`);
                    break;
                }

                success = true;
                break;
            } catch (error) {
                if (attempt < maxRetries && loginFn) {
                    console.log(`⚠️ Erro na página ${page + 1}: ${error.message} - tentando re-login (tentativa ${attempt + 1})...`);
                    try {
                        await loginFn();
                        await sleep(1000);
                    } catch (loginError) {
                        console.error(`❌ Re-login falhou: ${loginError.message}`);
                    }
                    continue;
                }
                console.error(`❌ Erro ao buscar página ${page + 1}:`, error.message);
                break;
            }
        }

        if (!success) {
            break;
        }

        const tickets = parseTicketsFromHTML(response.data);

        if (tickets.length === 0) {
            console.log(`✅ Página ${page + 1} sem tickets - fim da paginação`);
            break;
        }

        console.log(`   Encontrados ${tickets.length} tickets na página ${page + 1}`);

        // Extrair estado atualizado
        let newKeys;
        try {
            const newState = extractStateFromResponse(response.data, `Página ${page + 1}`);
            currentCallbackState = newState.callbackState;
            currentCustomOperationState = newState.customOperationState;
            newKeys = newState.keys.length > 0 ? newState.keys : tickets.map(t => t.number.trim());
        } catch (e) {
            console.log(`   ⚠️ Não foi possível extrair estado da página ${page + 1}: ${e.message}`);
            newKeys = tickets.map(t => t.number.trim());
        }

        // Detectar se o DevExpress retornou a mesma página (keys idênticas = última página)
        // Comparação apenas da primeira key — o DevExpress pode retornar menos keys na última página
        // (ex: 10 em vez de 50), mas a primeira key será igual se é a mesma página.
        if (newKeys.length > 0 && previousTicketIds.length > 0 &&
            newKeys[0] === previousTicketIds[0]) {
            console.log(`✅ Página ${page + 1}: mesmas keys da página anterior - fim da paginação`);
            break;
        }

        previousTicketIds = newKeys;

        // Verificar se todos os tickets desta página já foram vistos (duplicatas)
        let allDuplicates = true;
        for (const ticket of tickets) {
            const id = ticket.link ? ticket.link.match(/TicketPrincipal\/(\d+)/)?.[1] : ticket.number.trim();
            if (id && !seenTicketIds.has(id)) {
                allDuplicates = false;
                seenTicketIds.add(id);
            }
        }

        if (allDuplicates) {
            console.log(`✅ Página ${page + 1}: todos os ${tickets.length} tickets já coletados - fim da paginação`);
            break;
        }

        // Adicionar todos os tickets da página
        allTickets.push(...tickets);

        // Delay entre páginas
        if (page < maxPages - 1) {
            console.log(`   Aguardando ${PAGE_DELAY_MS / 1000}s antes da próxima página...`);
            await sleep(PAGE_DELAY_MS);
        }
    }

    console.log(`\n✅ Coleta concluída! Total: ${allTickets.length} tickets (customSearchMenu=${customSearchMenuId})`);
    return allTickets;
}

/**
 * Busca todos os tickets de um cliente, iterando por todas as páginas.
 * 
 * Fluxo:
 * 1. Carrega /Ticket para inicializar o grid e extrair estados dinâmicos
 * 2. Configura o grid com 3 steps de callback (filtro cliente, remove GrupoTipo, status) replicando o browser
 * 3. Pagina com PAGERONCLICK3|PBN (Page Button Next) para ObterListaPaginacao
 * 4. Para a paginação assim que encontrar um ticket com lastUpdateDate mais antiga que MAX_AGE_MONTHS
 * 
 * Para quando:
 * - Um ticket na página tem lastUpdateDate (último trâmite) mais antiga que MAX_AGE_MONTHS (dados ordenados desc)
 * - A página retorna 0 tickets (fim dos dados)
 * - generalError retornado pelo DevExpress (fim da paginação)
 * - Atingiu o limite máximo de páginas (segurança)
 * 
 * @param {string} clientName - Nome do cliente para filtrar
 * @param {object} session - Instância do axios com cookies (sessão autenticada)
 * @param {function} loginFn - Função de login para re-autenticar se sessão expirar
 * @returns {Array} - Array com todos os tickets coletados (filtrados por data)
 */
export async function fetchAllTickets(clientName, session, loginFn) {
    const allTickets = [];
    const dateLimit = getDateLimit();
    const maxPages = 100; // Segurança contra loop infinito
    const maxRetries = 2; // Máximo de tentativas de re-login por página

    console.log(`📋 Iniciando coleta paginada para "${clientName}"`);
    console.log(`📅 Data limite: ${dateLimit.toLocaleDateString('pt-BR')} (${MAX_AGE_MONTHS} meses atrás)`);

    // Passo 1: Inicializar o grid e extrair estados
    let gridState;
    try {
        gridState = await initializeGridState(session);
    } catch (error) {
        console.error(`❌ Falha ao inicializar grid: ${error.message}`);
        // Tentar re-login e tentar novamente
        if (loginFn) {
            console.log('🔄 Tentando re-login e reinicializar grid...');
            await loginFn();
            await sleep(1000);
            gridState = await initializeGridState(session);
        } else {
            throw error;
        }
    }

    const { callbackState: initialCallbackState, customOperationState: initialCustomOperationState, initialKeys } = gridState;

    // Passo 2: Configurar todos os filtros do grid (3 steps replicando o browser)
    // Isso aplica: filtro de cliente, remoção do GrupoTipo, e filtro de Status
    let filterResult;
    try {
        filterResult = await setupGridFilters(session, clientName, initialCallbackState, initialCustomOperationState, initialKeys);
    } catch (error) {
        console.error(`❌ Falha ao configurar grid: ${error.message}`);
        if (loginFn) {
            console.log('🔄 Tentando re-login e reconfigurar grid...');
            await loginFn();
            await sleep(1000);
            gridState = await initializeGridState(session);
            const { callbackState: retryCS, customOperationState: retryCOS, initialKeys: retryKeys } = gridState;
            filterResult = await setupGridFilters(session, clientName, retryCS, retryCOS, retryKeys);
        } else {
            throw error;
        }
    }

    const { callbackState: filteredCallbackState, customOperationState: filteredCustomOperationState, keys: filteredKeys, firstPageTickets } = filterResult;

    // Adicionar tickets da primeira página que estão dentro do limite de data
    // Tickets vêm ordenados por último trâmite desc, então paramos quando encontramos um fora do limite
    let reachedDateLimit = false;
    if (firstPageTickets.length > 0) {
        for (const ticket of firstPageTickets) {
            if (ticket.lastUpdateDate && ticket.lastUpdateDate < dateLimit) {
                reachedDateLimit = true;
                break;
            }
            allTickets.push(ticket);
        }
        console.log(`   ${allTickets.length} tickets coletados da página 1${reachedDateLimit ? ' (atingiu limite de data)' : ''}`);
    }

    let previousTicketIds = filteredKeys.length > 0 ? filteredKeys : firstPageTickets.map(t => t.number.trim());

    // Estados mutáveis que são atualizados a cada resposta de paginação
    let currentCallbackState = filteredCallbackState;
    let currentCustomOperationState = filteredCustomOperationState;

    // Se a primeira página já não tem tickets, ou atingiu o limite de data, não precisa paginar
    if (firstPageTickets.length === 0) {
        console.log(`✅ Nenhum ticket encontrado para o cliente "${clientName}"`);
        return [];
    }

    if (reachedDateLimit) {
        console.log(`📅 Limite de ${MAX_AGE_MONTHS} meses atingido na página 1 - parando paginação`);
        console.log(`\n✅ Coleta concluída! Total: ${allTickets.length} tickets de "${clientName}" nos últimos ${MAX_AGE_MONTHS} meses`);
        return allTickets;
    }

    // Passo 3: Paginar e coletar o restante dos tickets usando PBN (Page Button Next)
    for (let page = 1; page < maxPages; page++) {
        console.log(`📄 Buscando página ${page + 1} (PBN)...`);

        let response = null;
        let success = false;

        // Tentar buscar a página, com re-login se sessão expirar
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                const body = buildRequestBody(clientName, currentCallbackState, currentCustomOperationState, previousTicketIds);

                response = await session.post(PAGINATION_URL, body, {
                    headers: DX_HEADERS,
                });

                if (!response || response.status !== 200) {
                    console.error(`❌ Erro na página ${page + 1}: status ${response?.status}`);
                    break;
                }

                // Verificar se a resposta é o "generalError" do DevExpress (= sem mais páginas)
                if (response.data.includes("{'generalError':''}")) {
                    console.log(`✅ Página ${page + 1}: generalError - fim da paginação`);
                    success = false; // Não processar, mas não é erro
                    break;
                }

                // Verificar se a resposta tem conteúdo real (não é redirect de login)
                if (response.data.length < 500) {
                    if (attempt < maxRetries && loginFn) {
                        console.log(`⚠️ Resposta curta na página ${page + 1} (${response.data.length} chars) - tentando re-login (tentativa ${attempt + 1})...`);
                        await loginFn();
                        await sleep(1000); // Pequeno delay após login
                        continue; // Retry a mesma página
                    }
                    console.log(`⚠️ Resposta muito curta na página ${page + 1} (${response.data.length} chars) - sessão expirada e re-login falhou`);
                    break;
                }

                success = true;
                break; // Saiu do loop de retentativas

            } catch (error) {
                if (attempt < maxRetries && loginFn) {
                    console.log(`⚠️ Erro na página ${page + 1}: ${error.message} - tentando re-login (tentativa ${attempt + 1})...`);
                    try {
                        await loginFn();
                        await sleep(1000);
                    } catch (loginError) {
                        console.error(`❌ Re-login falhou: ${loginError.message}`);
                    }
                    continue;
                }
                console.error(`❌ Erro ao buscar página ${page + 1}:`, error.message);
                break;
            }
        }

        if (!success) {
            break; // Sair do loop de páginas
        }

        const tickets = parseTicketsFromHTML(response.data);

        if (tickets.length === 0) {
            console.log(`✅ Página ${page + 1} sem tickets - fim da paginação`);
            break;
        }

        console.log(`   Encontrados ${tickets.length} tickets na página ${page + 1}`);

        // Extrair estado atualizado da resposta para a próxima requisição
        let newKeys;
        try {
            const newState = extractStateFromResponse(response.data, `Página ${page + 1}`);
            currentCallbackState = newState.callbackState;
            currentCustomOperationState = newState.customOperationState;
            newKeys = newState.keys.length > 0 ? newState.keys : tickets.map(t => t.number.trim());
        } catch (e) {
            console.log(`   ⚠️ Não foi possível extrair estado da página ${page + 1}: ${e.message}`);
            // Fallback: usar os IDs dos tickets parseados
            newKeys = tickets.map(t => t.number.trim());
        }

        // Detectar se o DevExpress retornou a mesma página (keys idênticas = última página)
        // Comparação apenas da primeira key — o DevExpress pode retornar menos keys na última página
        if (newKeys.length > 0 && previousTicketIds.length > 0 &&
            newKeys[0] === previousTicketIds[0]) {
            console.log(`✅ Página ${page + 1}: mesmas keys da página anterior - fim da paginação`);
            break;
        }

        previousTicketIds = newKeys;

        // Adicionar tickets dentro do limite de data (ordenados por último trâmite desc)
        // Quando encontrar um ticket fora do limite, parar imediatamente
        for (const ticket of tickets) {
            if (ticket.lastUpdateDate && ticket.lastUpdateDate < dateLimit) {
                reachedDateLimit = true;
                break;
            }
            allTickets.push(ticket);
        }

        if (reachedDateLimit) {
            console.log(`📅 Limite de ${MAX_AGE_MONTHS} meses atingido na página ${page + 1} - parando paginação`);
            break;
        }

        // Delay entre páginas
        if (page < maxPages - 1) {
            console.log(`   Aguardando ${PAGE_DELAY_MS / 1000}s antes da próxima página...`);
            await sleep(PAGE_DELAY_MS);
        }
    }

    console.log(`\n✅ Coleta concluída! Total: ${allTickets.length} tickets de "${clientName}" nos últimos ${MAX_AGE_MONTHS} meses`);
    return allTickets;
}
