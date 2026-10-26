/**
 * El trazo a mano: lo que tiene que seguir siendo verdad cuando el motor deja la regla.
 *
 * Un dibujo temblón solo sirve si el temblor es **el mismo siempre**. Un SVG que cambia
 * entre dos ejecuciones no se puede versionar, no se puede comparar en una revisión y hace
 * que cada captura de `visual-check` salga distinta sin que nadie haya tocado nada.
 */
import { describe, expect, it } from './vitest.ts';
import { renderTyped } from '../src/render/typed.ts';
import { composition } from '../src/render/compose.ts';
import { inkPath, pathPoints } from '../src/render/hand.ts';
import type { DiagramModel } from '../src/model.ts';

const model: DiagramModel = {
  kind: 'process',
  title: 'Un proceso',
  direction: 'TD',
  nodes: [
    { id: 'a', shape: 'stadium', name: 'Empieza', x: 40, y: 40 },
    { id: 'b', shape: 'diamond', name: '¿Se puede?', x: 40, y: 200 },
    { id: 'c', shape: 'rect', name: 'Hacerlo', x: 40, y: 400 },
    { id: 'd', shape: 'cylinder', name: 'Guardarlo', x: 320, y: 400 },
  ],
  edges: [
    { id: 'e1', from: 'a', to: 'b', label: '' },
    { id: 'e2', from: 'b', to: 'c', label: 'Sí' },
    { id: 'e3', from: 'c', to: 'd', label: '' },
  ],
};

describe('la mano', () => {
  it('no viene puesta —líneas limpias, a juego con la interfaz—, y la mano sigue estando para quien la pida', () => {
    expect(renderTyped(model, { idPrefix: 'p' }).svg).not.toContain('style="stroke:none"');
    expect(renderTyped(model, { idPrefix: 'p', hand: 1 }).svg).toContain('style="stroke:none"');
  });

  it('dibuja lo mismo dos veces', () => {
    const a = renderTyped(model, { idPrefix: 'p', hand: 1 }).svg;
    const b = renderTyped(model, { idPrefix: 'p', hand: 1 }).svg;
    expect(a).toBe(b);
    expect(a).not.toBe(renderTyped(model, { idPrefix: 'p', hand: false }).svg);
  });

  it('añadir una pieza no vuelve a dibujar las demás', () => {
    /*
     * La semilla es el id de cada pieza, no la posición en una lista ni un contador que
     * corre por el documento. Sin eso, meter una caja cambiaría el temblor de todas las que
     * vienen detrás y el diff de una captura diría que cambió el dibujo entero.
     */
    const antes = renderTyped(model, { idPrefix: 'p', hand: 1 }).svg;
    const mas: DiagramModel = { ...model, nodes: [...model.nodes, { id: 'z', shape: 'rect', name: 'Otra', x: 600, y: 40 }] };
    const despues = renderTyped(mas, { idPrefix: 'p', hand: 1 }).svg;
    const silueta = (svg: string, id: string) => svg.slice(svg.indexOf(`data-id="${id}"`)).split('</g>')[0];
    for (const id of ['a', 'b', 'c', 'd']) expect(silueta(despues, id)).toBe(silueta(antes, id));
  });

  it('el forro y la línea de una flecha llevan exactamente la misma tinta', () => {
    const svg = renderTyped(model, { idPrefix: 'p', hand: 1 }).svg;
    const casing = [...svg.matchAll(/<path class="pd-casing" d="([^"]+)"/g)].map((m) => m[1]);
    const line = [...svg.matchAll(/<path class="pd-line" d="([^"]+)"/g)].map((m) => m[1]);
    expect(casing.length).toBeGreaterThan(0);
    // Dos tintas distintas dejarían asomar el blanco del forro por el borde de la línea,
    // que es justo el efecto que el forro existe para evitar.
    expect(line).toEqual(casing);
  });

  it('no toca lo que no es un trazo', () => {
    const svg = renderTyped(model, { idPrefix: 'p', hand: 1 }).svg;
    // La punta de flecha es mobiliario de la hoja, no dibujo de nadie.
    const marker = /<marker id="p-arrow"[\s\S]*?<\/marker>/.exec(svg)![0];
    // Una punta de flecha temblona no se lee como una punta: se lee como un borrón.
    expect(marker).toContain('class="pd-head"');
    expect(marker).not.toContain('C');
    expect(marker).not.toContain('style="fill:none');
  });

  it('cada pieza se rellena una vez y se entinta una vez', () => {
    const svg = renderTyped(model, { idPrefix: 'p', hand: 1 }).svg;
    /*
     * Un contorno a mano son ocho trazos sueltos que se cruzan en las esquinas: relleno así
     * sale con agujeros. Se parte en dos — el relleno sobre la silueta de verdad, la tinta
     * encima— y las dos mitades se declaran en línea porque la hoja pinta por clase y una
     * declaración gana a un atributo.
     */
    expect((svg.match(/style="stroke:none"/g) ?? []).length).toBeGreaterThanOrEqual(model.nodes.length);
    expect(svg).toContain('style="fill:none;stroke-linecap:round;stroke-linejoin:round"');
  });

  it('no se entinta lo ya entintado', () => {
    /*
     * Las tres sustituciones de `inked` se encadenan sobre su propia salida: un rectángulo
     * se convierte en ruta, y una ruta es lo que busca la regla siguiente. En el orden malo
     * cada caja se entintaba, se volvía ruta y **se entintaba otra vez** —el contorno rugoso
     * aplanado a puntos y vuelto a rugar encima de sí mismo—. No se veía mal. El dibujo
     * pesaba catorce veces lo que debía y cada fotograma de un arrastre lo pagaba.
     */
    const svg = renderTyped(model, { idPrefix: 'p', hand: 1 }).svg;
    const caja = /<g class="pd-node[^"]*" data-id="c"[^>]*>([\s\S]*?)<\/g>/.exec(svg)![1];
    const curvas = (caja.match(/C/g) ?? []).length;
    // Un rectángulo son cuatro esquinas de tres muestras: dieciséis aristas, dos pasadas.
    expect(curvas).toBeGreaterThan(8);
    expect(curvas).toBeLessThan(80);
  });

  it('cuesta lo que un dibujo a mano cuesta, y no más', () => {
    const recto = renderTyped(model, { idPrefix: 'p', hand: false }).svg.length;
    const mano = renderTyped(model, { idPrefix: 'p', hand: 1 }).svg.length;
    // Tres veces la regla es el precio de la tinta; diez veces es un fallo.
    expect(mano / recto).toBeLessThan(4);
  });

  it('el dibujo sigue componiendo', () => {
    const recto = composition(renderTyped(model, { idPrefix: 'p', hand: false }), model);
    const mano = composition(renderTyped(model, { idPrefix: 'p', hand: 1 }), model);
    // El temblor son dos unidades: mueve tinta, no mueve cajas, así que no puede inventar
    // ni tapar una queja de composición.
    expect(mano.map((d) => d.code).sort()).toEqual(recto.map((d) => d.code).sort());
  });
});

describe('leer una ruta', () => {
  it('entiende los comandos que este motor escribe, y deja en paz los que no', () => {
    expect(pathPoints('M0 0 L10 0 L10 10 Z')).toEqual([{ points: [[0, 0], [10, 0], [10, 10]], closed: true }]);
    expect(pathPoints('M0 0 h10 v10 H0 V0')[0].points).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    // Un arco y una curva se muestrean; lo importante es que empiecen y acaben donde deben.
    const arco = pathPoints('M0 10 a10 10 0 0 1 20 0')[0].points;
    expect(arco[arco.length - 1][0]).toBeCloseTo(20, 1);
    // Un comando que no escribe nadie aquí: se devuelve la ruta intacta antes que adivinarla.
    expect(pathPoints('M0 0 Q5 5 10 0')).toEqual([]);
    expect(inkPath('M0 0 Q5 5 10 0', 'x')).toBe('M0 0 Q5 5 10 0');
  });

  it('una ruta entintada empieza cerca de donde empezaba', () => {
    const d = inkPath('M100 100 L300 100', 'una-pieza', 1);
    const [, x, y] = /^M(-?[\d.]+) (-?[\d.]+)/.exec(d)!.map(Number);
    expect(Math.abs(x - 100)).toBeLessThan(4);
    expect(Math.abs(y - 100)).toBeLessThan(4);
  });
});
