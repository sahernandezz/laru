/** «Servicios y entornos» is one place with two views: the map of what is deployed, and the environments it runs in. */
import { href } from '../lib/route.ts';
import { MountAll } from './MountAll.tsx';

export function MapTabs({ active }: { active: 'map' | 'envs' }) {
  return (
    <div className="map-tabs">
    <nav className="tabs" aria-label="Servicios y entornos">
      <a href={href('map')} aria-current={active === 'map' ? 'page' : undefined} className={active === 'map' ? 'on' : undefined}>Mapa y servicios</a>
      <a href={href('envs')} aria-current={active === 'envs' ? 'page' : undefined} className={active === 'envs' ? 'on' : undefined}>Entornos</a>
    </nav>
    <span className="map-tabs-act"><MountAll /></span>
    </div>
  );
}
