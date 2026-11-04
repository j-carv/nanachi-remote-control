// Entrada enxuta. O zod precisa estar sem JIT antes de existir qualquer schema: o shared e o app criam schemas
// ao carregar (e o zod 4 testa `new Function` nessa hora, bloqueado pela CSP). Por isso o app entra por import()
// depois da configuração: imports estáticos de chunks compartilhados avaliam antes do corpo deste arquivo.
import './zodJitless.js';
import './styles.css';

void import('./bootstrap.js');
