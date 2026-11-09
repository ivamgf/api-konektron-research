import { esc } from '#pdf/render.ts';

/** Tipos de metodologia do protocolo (passo Metodologia) */
export const METODOLOGIAS = {
  DSR: 'Design Science Research (DSR)',
  QUANTITATIVA: 'Pesquisa quantitativa',
  QUALITATIVA: 'Pesquisa qualitativa',
  MISTA: 'Métodos mistos (quali-quantitativa)',
  REVISAO_SISTEMATICA: 'Revisão sistemática da literatura',
  REVISAO_INTEGRATIVA: 'Revisão integrativa',
  REVISAO_ESCOPO: 'Revisão de escopo (scoping review)',
  REVISAO_NARRATIVA: 'Revisão narrativa',
  BIBLIOMETRIA: 'Estudo bibliométrico',
  ESTUDO_CASO: 'Estudo de caso',
  PESQUISA_ACAO: 'Pesquisa-ação',
  EXPERIMENTAL: 'Pesquisa experimental',
  QUASE_EXPERIMENTAL: 'Pesquisa quase-experimental',
  SURVEY: 'Levantamento (survey)',
  ETNOGRAFIA: 'Etnografia',
  TEORIA_FUNDAMENTADA: 'Teoria fundamentada (grounded theory)',
  FENOMENOLOGIA: 'Pesquisa fenomenológica',
  DOCUMENTAL: 'Pesquisa documental',
  BIBLIOGRAFICA: 'Pesquisa bibliográfica',
  EXPLORATORIA: 'Pesquisa exploratória',
  DESCRITIVA: 'Pesquisa descritiva',
  EXPLICATIVA: 'Pesquisa explicativa',
  DELPHI: 'Método Delphi',
  OUTRA: 'Outra',
} as const;
export type Metodologia = keyof typeof METODOLOGIAS;
export const CODIGOS_METODOLOGIA = Object.keys(METODOLOGIAS) as [Metodologia, ...Metodologia[]];

export const nomeMetodologia = (p: { metodologiaTipo?: string | null; metodologiaOutro?: string | null }) =>
  p.metodologiaTipo === 'OUTRA'
    ? p.metodologiaOutro || 'Outra'
    : p.metodologiaTipo
      ? (METODOLOGIAS[p.metodologiaTipo as Metodologia] ?? p.metodologiaTipo)
      : null;

type DadosTcle = {
  projeto: { titulo: string; instituicao?: string | null; programa?: string | null };
  equipe: { nome: string; email?: string | null; papel: string }[];
  protocolo: {
    objetivoGeral?: string | null;
    justificativa?: string | null;
    metodologiaTipo?: string | null;
    metodologiaOutro?: string | null;
    metodologia?: string | null;
    riscos?: string | null;
    beneficios?: string | null;
  };
};

// texto do protocolo em parágrafos; vazio vira o marcador para o pesquisador preencher
const pars = (v: string | null | undefined, marcador: string) =>
  v?.trim()
    ? v
        .split(/\n{2,}|\r\n\r\n/)
        .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
        .join('')
    : `<p>${campo(marcador)}</p>`;
const campo = (texto: string) => `<span class="preencher">[${esc(texto)}]</span>`;

/**
 * Modelo de TCLE (Termo de Consentimento Livre e Esclarecido) em HTML compatível com o Word:
 * baixado como .doc, abre editável no Word/LibreOffice. Traz o que o sistema já sabe (título,
 * equipe, instituição, objetivo, procedimentos, riscos e benefícios) e marca entre colchetes o que
 * o pesquisador completa. Estrutura nas seções usuais de um TCLE (Res. CNS 466/2012 e 510/2016).
 */
export function modeloTcle(d: DadosTcle) {
  const responsavel = d.equipe.find((m) => m.papel === 'RESPONSAVEL') ?? d.equipe[0];
  const orientador = d.equipe.find((m) => m.papel === 'ORIENTADOR');
  const equipe = d.equipe.filter((m) => m.papel !== 'LEITOR');
  const instituicao = [d.projeto.programa, d.projeto.instituicao].filter(Boolean).join(' — ');
  const metodo = nomeMetodologia(d.protocolo);
  const contato = (m: { nome: string; email?: string | null }, papel: string) =>
    `<li>${esc(m.nome)} (${esc(papel)}) — e-mail: ${m.email ? esc(m.email) : campo('e-mail')}; telefone: ${campo('telefone')}</li>`;

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>TCLE — ${esc(d.projeto.titulo)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
@page { size: 21cm 29.7cm; margin: 2.5cm 2cm 2cm 2.5cm; }
body { font-family: Calibri, Arial, sans-serif; font-size: 12pt; line-height: 1.5; }
h1 { font-size: 13pt; text-align: center; text-decoration: underline; margin: 0 0 12pt; }
h2 { font-size: 12pt; margin: 14pt 0 4pt; }
p { text-align: justify; margin: 0 0 6pt; text-indent: 1.25cm; }
li p, td p { text-indent: 0; }
table.id { width: 100%; border-collapse: collapse; margin-bottom: 12pt; }
table.id td, table.id th { border: 1px solid #000; padding: 3pt 6pt; vertical-align: top; }
table.id th { background: #DCE6F2; text-align: center; }
.preencher { background: #FFF2A8; }
.nota { font-size: 10pt; color: #555; text-indent: 0; }
.assin { width: 100%; margin-top: 36pt; }
.assin td { width: 50%; text-align: center; font-size: 10pt; padding: 0 12pt; vertical-align: top; }
</style></head>
<body>
<h1>TERMO DE CONSENTIMENTO LIVRE E ESCLARECIDO</h1>
<p class="nota">Modelo gerado pelo Konektron Research com os dados do protocolo. Revise todo o texto e substitua os trechos
<span class="preencher">[entre colchetes]</span> antes de submeter ao Comitê de Ética em Pesquisa (CEP). Ajuste a
forma de aceite (presencial ou em ambiente virtual) ao seu estudo.</p>

<table class="id">
<tr><th>IDENTIFICAÇÃO DO PROJETO</th></tr>
<tr><td>01. Título do projeto: ${esc(d.projeto.titulo)}</td></tr>
<tr><td>02. Pesquisador(a) principal: ${responsavel ? `${esc(responsavel.nome)} / ${responsavel.email ? esc(responsavel.email) : campo('e-mail')}` : campo('nome / e-mail')} / ${campo('telefone')}</td></tr>
<tr><td>03. Equipe de pesquisa: ${equipe.length ? esc(equipe.map((m) => m.nome).join(' / ')) : campo('nomes da equipe')}</td></tr>
<tr><td>04. Instituição proponente: ${instituicao ? esc(instituicao) : campo('instituição / programa')}</td></tr>
<tr><td>05. Patrocinador / financiamento: ${campo('agência de fomento ou "sem financiamento"')}</td></tr>
</table>

<p>Você está sendo convidado(a) a participar do projeto de pesquisa <b>${esc(d.projeto.titulo)}</b>${instituicao ? `, vinculado ao(à) ${esc(instituicao)}` : ''}, cujas informações estão descritas acima.</p>
<p>É importante que você leia, ou que alguém leia para você, este documento com atenção. Em caso de dúvida ou de qualquer informação que não entenda, peça ao(à) pesquisador(a) responsável que explique.</p>
<p>Você não é obrigado(a) a participar. Ao final deste documento há um termo de aceite com as opções “SIM” e “NÃO”. Você pode se recusar ou se retirar do estudo a qualquer momento, sem precisar justificar e sem qualquer prejuízo.</p>

<h2>Por que esta pesquisa está sendo feita?</h2>
${pars(d.protocolo.justificativa, 'explique, em linguagem simples, o problema e a motivação do estudo')}
<p>O objetivo principal do estudo é:</p>
${pars(d.protocolo.objetivoGeral, 'objetivo geral em linguagem acessível ao participante')}

<h2>Se eu aceitar participar, o que vou fazer?</h2>
${metodo ? `<p>Trata-se de um estudo do tipo <b>${esc(metodo)}</b>.</p>` : ''}
${pars(d.protocolo.metodologia, 'descreva os procedimentos: onde, quando, quanto tempo, quais atividades, instrumentos (questionário, entrevista, teste), gravações')}
<p>Tempo estimado de participação: ${campo('ex.: 30 minutos')}.</p>

<h2>Quais são os riscos e desconfortos?</h2>
${pars(d.protocolo.riscos, 'riscos e desconfortos previsíveis (toda pesquisa com seres humanos envolve riscos, ainda que mínimos)')}
<p>Para minimizar esses riscos, serão adotadas as seguintes precauções: ${campo('medidas de prevenção e de assistência ao participante')}.</p>
<p>Caso sinta qualquer desconforto, informe imediatamente a equipe de pesquisa, que prestará assistência e, se necessário, interromperá a atividade.</p>

<h2>Terei algum benefício?</h2>
${pars(d.protocolo.beneficios, 'benefícios diretos ou indiretos ao participante e à sociedade')}

<h2>Quais são os meus direitos?</h2>
<p>Ao participar, você não renuncia a nenhum direito, incluindo o direito de pedir indenização e assistência a que legalmente tenha direito. Está garantido o ressarcimento de despesas decorrentes da participação e a indenização por eventuais danos.</p>

<h2>Vou ser pago para participar?</h2>
<p>A participação é voluntária e não há pagamento de qualquer tipo.</p>

<h2>Minha identidade será mantida em sigilo?</h2>
<p>Sim. As informações coletadas serão tratadas com confidencialidade e usadas apenas para os fins desta pesquisa, identificadas por código, sem ligação direta com seu nome. Imagens, áudio ou vídeo só serão obtidos com o seu consentimento prévio. Os dados serão armazenados com segurança e, ao final, arquivados ou descartados conforme a Resolução CNS 466/2012 e a Lei Geral de Proteção de Dados (Lei 13.709/2018). ${campo('por quanto tempo os dados serão guardados e onde')}</p>

<h2>Com quem posso falar em caso de dúvidas?</h2>
<p>Em caso de dúvidas, ou se quiser desistir, entre em contato com:</p>
<ol>${responsavel ? contato(responsavel, 'pesquisador(a) responsável') : `<li>${campo('pesquisador(a) responsável — e-mail e telefone')}</li>`}${orientador && orientador !== responsavel ? contato(orientador, 'orientador(a)') : ''}</ol>
<p>Endereço da instituição: ${campo('endereço, sala/laboratório e telefone')}.</p>
<p>Se tiver dúvidas sobre seus direitos como participante de pesquisa, procure o Comitê de Ética em Pesquisa: ${campo('nome do CEP, endereço, telefone, e-mail e horário de atendimento')}. O CEP é um colegiado independente, criado para defender os interesses dos participantes em sua integridade e dignidade. Se necessário, você também pode contatar a Comissão Nacional de Ética em Pesquisa (CONEP).</p>

<h2>TERMO DE ACEITE</h2>
<p>Declaro que li (ou que leram para mim) este termo, entendi as informações e concordo voluntariamente em participar desta pesquisa.</p>
<p>(&nbsp;&nbsp;&nbsp;) SIM&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;(&nbsp;&nbsp;&nbsp;) NÃO&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;E-mail para receber uma via: ______________________________</p>
<p>Este documento é assinado em duas vias de igual teor; o participante recebe uma via assinada e rubricada.</p>
<table class="assin"><tr>
<td>_________________________________<br>Nome por extenso do participante e/ou responsável legal</td>
<td>_________________________________<br>Assinatura do participante e/ou responsável legal</td>
</tr></table>
<p class="nota" style="margin-top:18pt"><i>(Somente para o responsável pelo projeto)</i></p>
<p>Declaro que obtive, de forma apropriada e voluntária, o Consentimento Livre e Esclarecido deste participante ou de seu representante legal.</p>
<table class="assin"><tr>
<td>_________________________________<br>Nome por extenso do pesquisador e/ou de quem aplicou o TCLE</td>
<td>_________________________________<br>Assinatura do pesquisador e/ou de quem aplicou o TCLE</td>
</tr></table>
<p style="text-indent:0;margin-top:24pt">${campo('Cidade')}, ____ de ______________ de ______.</p>
</body></html>`;
}
