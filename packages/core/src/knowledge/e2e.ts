/**
 * Laru's standard for flows: the story is what a person does on screen. One source for the guide a workspace
 * gets (`guide:flujos-e2e`), the flow's shape the AI reads, the tester's instructions and the scaffold; `laru
 * check` enforces it (`flow-e2e-*`). A guide, not a convention: an application's convention reaches every code edit
 * through the hooks, and a convention's rule is one or two sentences.
 */

export const E2E_RULES = [
  'La historia es lo que hace una persona en pantalla: cada paso actúa con la interfaz (clics, teclado, ficheros) y comprueba lo que la persona ve. Nada pasa por debajo: ni la API ni `fetch`, ni una sesión que pone el script (`addInitScript`, cookies, `localStorage`), ni rutas simuladas (`page.route`), eventos sintéticos o el DOM cambiado con `evaluate`.',
  'Lo que la pantalla puede mostrar se comprueba en la pantalla. `observed` y las consultas a datos solo complementan con la dependencia que no se ve (un fichero en el bucket, un mensaje en una cola); nunca sustituyen a lo visible.',
  'Preparación: lo que existe antes del flujo (una cuenta, un fichero, una sesión) se crea en `prepare(\'<Dato>\', …)` antes del primer paso de la historia, cada uno una fila de «Precondiciones», con `await` donde se escribe, en la historia o un helper del spec; nunca entre pasos (un cambio por debajo a mitad del flujo no es una precondición), dentro de otra función (un callback, un manejador de eventos, el método de un objeto), en un hook (`beforeEach`, `beforeAll`) ni arriba del spec, y un helper que prepara se llama, no se pasa como valor. Por debajo (la API, una sesión) solo si su «Probado en» nombra un flujo que hace ese camino por la interfaz (su historia juega sus Pasos, cada paso comprobando lo que ve la persona), no prepara ese mismo Dato por debajo y solo se apoya en flujos que cumplen lo mismo.',
  'Validaciones: cada formulario que la historia rellena tiene sus pasos de validación (vacío, formato, límites, permiso), filas de «Pasos» con Tipo `validation`; cada uno comprueba el mensaje que la persona ve. Cada formulario que se rellena con un helper compartido (iniciar sesión, subir un fichero) los tiene aquí o en un flujo que nombra «Validaciones en», que los prueba en pantalla: un paso de validación prueba el formulario que rellena el último él mismo, en línea o con la función que lo rellena, no con un helper que lo rellena de camino (un inicio de sesión que espera la página siguiente).',
  'Un flujo es una sola historia grabada, en un solo vídeo: no tiene casos aparte (`test()` o `apiCase()` junto a la historia). Una validación o una variación es un paso más de la historia.',
  'Localizadores por rol, etiqueta o texto visible (`getByRole`, `getByLabel`, `getByText`); nada de esperas fijas: se espera a lo que se ve.',
  'Un `step()` por fila de «Pasos», con los mismos títulos y en el mismo orden; cada «Se espera», comprobado con un `expect` sobre lo que la persona ve (o la descarga que recibe).',
  'Una desviación de la aplicación se comprueba con `expect.soft` sobre lo que debería hacer, con un comentario `// app:` en su línea o en la anterior que dice lo que hace hoy: la ejecución la muestra en rojo hasta que se arregle. Nunca se comprueba lo que hace mal, ni se esconde la prueba (`test.skip`, `test.fixme`, `test.fail`), ni se traga un fallo (`.catch` o un `.then` de dos argumentos sobre un `expect` o sobre lo que lo contiene, `Promise.allSettled`, `any` o `race`, un `try` cuyo `catch` no relanza siempre, un helper que hace eso con lo que recibe), ni se debilita la aserción.',
  'Se termina cuando el flujo corre (`laru test <flujo>`) y solo fallan sus `expect.soft` marcados `// app:`, y `laru check` no deja avisos `flow-*` en los flujos tocados: ni un `todo()` ni un `\'…\'` del andamio.',
  'Lo que la aplicación envía a un buzón (un correo, un SMS) se comprueba con `mail.waitFor` o `sms.waitFor`, además de lo visible; el enlace o el código que trae se usa tal cual, nunca se inventa. Un correo que se lee en el navegador de la prueba es una trampa, no un atajo.',
  'Un flujo también se revisa leyéndolo, como cualquier código: `laru check` encuentra las formas habituales de saltarse estas reglas, no todas, y quien quiera engañarlo puede (una preparación metida en un `Promise.all`, un método de clase que actúa por debajo). Que no avise no basta.',
];

export const E2E_GUIDE = {
  type: 'guide' as const,
  id: 'guide:flujos-e2e',
  title: 'Escribir un flujo e2e',
  status: 'active',
  summary: 'El estándar de Laru para los flujos: la historia es lo que hace una persona en pantalla; laru check lo vigila.',
  fields: {
    goal: 'Un flujo que es documentación y prueba a la vez: su historia es lo que una persona hace y ve en la pantalla, sus pasos de validación prueban los mensajes que esa persona encuentra, todo en un solo vídeo, y nada que la pantalla pueda mostrar pasa escondido por debajo.',
    steps: E2E_RULES,
    troubleshooting: [
      { symptom: '`flow-e2e-api`: un paso hace algo por debajo (la API, `fetch`, una sesión que pone el script)', fix: 'Hazlo en la pantalla. Lo que la pantalla no puede mostrar se comprueba con `observed`, además de lo visible.' },
      { symptom: '`flow-e2e-invisible`: un paso no comprueba nada que la persona vea o reciba', fix: 'Añade el `expect` de su «Se espera» sobre lo que ve la persona (`toBeVisible`, `toHaveText`…) o la descarga que recibe.' },
      { symptom: '`flow-e2e-wait`: una espera fija', fix: 'Espera a lo que se ve: `await expect(…).toBeVisible()`.' },
      { symptom: '`flow-e2e-prepare`: preparación fuera de `prepare()` (en un hook o arriba del spec), un `prepare()` después del primer paso, sin `await`, dentro de otra función (un callback, un manejador de eventos, el método de un objeto), un helper que prepara pasado como valor, sin fila en «Precondiciones», o por debajo sin un «Probado en» que la haga por la interfaz', fix: 'Muévela a `prepare(\'<Dato>\', …)` con `await`, antes del primer paso de la historia, en la historia o un helper del spec, declárala en «Precondiciones» con el flujo que la hace por la interfaz (y no por debajo, ni apoyado en otro que lo haga), o hazla por la interfaz. Lo que cambia a mitad del flujo lo hace la persona en pantalla.' },
      { symptom: '`flow-e2e-validation`: la historia rellena un formulario y «Pasos» no tiene pasos `validation`, un formulario que rellena con un helper no lo prueba ningún paso de validación de aquí ni de un flujo de «Validaciones en», o «Validaciones en» nombra un flujo que no los prueba', fix: 'Añade sus pasos de validación (Tipo `validation`): vacío, formato, límites y permiso, cada uno con el mensaje que ve la persona, rellenando el formulario él mismo (en línea o con la función que lo rellena). Si el formulario se rellena con un helper compartido y sus validaciones viven en otro flujo, nómbralo en «Validaciones en».' },
      { symptom: '`flow-e2e-case`: un `test()` o un `apiCase()` junto a la historia', fix: 'Un flujo es una sola historia grabada: hazlo un `step()` de la historia, con su fila en «Pasos» (Tipo `validation` si valida un formulario), después de lo que deja la pantalla lista para él.' },
      { symptom: '`flow-e2e-fake`: una ruta simulada, un evento sintético o el DOM cambiado por el script', fix: 'Quítalo: el flujo corre contra los servicios de verdad y la persona cambia la página.' },
      { symptom: '`flow-e2e-hidden`: la prueba con `test.skip`, `test.fixme`, `test.fail` u `.only`, un `expect` cuyo fallo se traga (`.catch` sobre él o sobre lo que lo contiene, `Promise.allSettled`, `any` o `race`, un `try` que no relanza siempre, un helper que traga lo que recibe), o un `expect.soft` (también con otro nombre: `const { soft } = expect`) sin `// app:` en su línea o en la anterior', fix: 'Déjalo correr y fallar. Si la aplicación falla, `expect.soft` sobre lo que debería hacer, con `// app:` diciendo lo que hace hoy.' },
      { symptom: '`flow-message-unchecked`: la aplicación envió correo o SMS en su último run y el spec nunca los comprueba', fix: 'Espera el mensaje con `mail.waitFor({ to })` o `sms.waitFor({ to })` y usa su enlace (`mail.links(m, { class: \'local\' })`) o su código (`sms.code(telefono)`) en la pantalla.' },
      { symptom: '`flow-e2e-todo`: queda un `todo()` o un `\'…\'` del andamio', fix: 'Escribe el cuerpo con los roles y textos de la aplicación. Luego córrelo hasta que pase.' },
      { symptom: '`flow-steps-drift`: los títulos o el orden no coinciden', fix: 'Iguala el título y el orden de cada `step()` con su fila de «Pasos».' },
    ],
  },
};
