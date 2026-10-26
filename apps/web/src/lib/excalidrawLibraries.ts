/**
 * The library panel of the diagram editor: the class's own pieces first, drawn by the
 * same scene compiler as the canvas, then the published Excalidraw libraries that suit the class. Each library is a
 * chunk of its own, loaded only when a class that wears it is opened. Sources and licence: generated/libraries/UPSTREAM.md.
 */
import type { LibraryItem, LibraryItems } from '@excalidraw/excalidraw/types';
import { SKINS, type DiagramModel } from '@laru/diagrams';
import { toScene } from './excalidrawScene.ts';

const LIBRARIES = import.meta.glob<{ default: { libraryItems?: LibraryItems; library?: unknown[][] } }>('../generated/libraries/*.excalidrawlib.json');

/** What every class's panel comes stocked with, then what each class wears. Known limit: a short curation; widen it as classes ask for more. */
const INSTALLED = ['c4', 'software-architecture', 'it-logos', 'aws'];
const BY_CLASS: Array<[RegExp, string[]]> = [
  [/^(process|process-landscape|value-stream)$/, ['bpmn']],
  [/^(c4-component|packages)$/, ['uml-component']],
  [/^(deployment|environment-map|network)$/, ['uml-deployment', 'k8s', 'network']],
  [/^(application-landscape|capabilities|domain-map|integration)$/, ['archimate-application']],
];
export const librariesForKind = (kind: string): string[] => [...BY_CLASS.filter(([re]) => re.test(kind)).flatMap(([, l]) => l), ...INSTALLED];

/** One library, or nothing: a pack that was never copied leaves the panel with the ones that were. */
async function load(pack: string): Promise<LibraryItems> {
  const from = LIBRARIES[`../generated/libraries/${pack}.excalidrawlib.json`];
  if (!from) return [];
  const file = (await from()).default;
  // version 2 carries `libraryItems`; version 1 (still published) an array of element arrays
  if (file.libraryItems) return file.libraryItems;
  return (file.library ?? []).map((elements, i) => ({ id: `legacy-${pack}-${i}`, status: 'published' as const, created: 0, elements })) as unknown as LibraryItems;
}

/** The pieces the class itself declares, as library items: the same silhouette and tone as on the canvas. */
export function pieceItems(kind: string): LibraryItem[] {
  const skin = SKINS[kind as keyof typeof SKINS];
  if (!skin) return [];
  const out: LibraryItem[] = [];
  for (const role of skin.roles) {
    const one = { kind, title: '', direction: 'TD', nodes: [{ id: 'p', shape: role.shape, name: role.shape, x: 0, y: 0, ...(role.form === 'boundary' ? { w: 320, h: 200 } : {}) }], edges: [] } as unknown as DiagramModel;
    try {
      const { elements } = toScene(one);
      if (elements.length) out.push({ status: 'published', id: `pd/${kind}/${role.shape}`, created: 0, name: role.shape, elements: elements as never });
    } catch { /* a shape its class cannot draw alone is not offered */ }
  }
  return out;
}

/** The items of the library panel; ids are unique (two packs can share one), the class's own first. */
export async function libraryItemsForKind(kind: string): Promise<LibraryItems> {
  const mine = pieceItems(kind);
  const { restoreLibraryItems } = await import('@excalidraw/excalidraw');
  const items = restoreLibraryItems((await Promise.all(librariesForKind(kind).map(load))).flat(), 'published');
  const byId = new Map<string, LibraryItem>();
  for (const item of [...mine, ...items]) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}
