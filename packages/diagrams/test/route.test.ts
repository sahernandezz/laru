/**
 * How an arrow gets from one box to another without going through a third.
 *
 * This was not in the plan. The plan said auto-layout for the derived classes and reached
 * for a solver; measuring first said otherwise. A landscape of forty-five pieces placed by
 * the layout the package already had produced six complaints from the composition pass, and
 * every one of them came from an arrow drawn straight through a box — none from where the
 * pieces were put. Routing them fixed all six, at four sizes, with no dependency added.
 *
 * So the order matters and is tested here: straight reads best and is tried first, an L is
 * one movement and comes next, a Z is a detour and is last.
 */
import { describe, expect, it } from './vitest.ts';
import { clear, labelAt, route } from '../src/index.ts';

const box = (id: string, x: number, y: number, w = 190, h = 78) => ({ id, x, y, w, h });
const ends: [string, string] = ['a', 'b'];

describe('route', () => {
  it('goes straight when nothing is in the way', () => {
    expect(route({ x: 0, y: 0 }, { x: 400, y: 0 }, [box('a', -190, -39), box('b', 400, -39)], ends))
      .toEqual([{ x: 0, y: 0 }, { x: 400, y: 0 }]);
  });

  it('turns one corner when the straight line is blocked', () => {
    // Squarely on the diagonal: at x=200 the straight line is at y=100, inside this box.
    const obstacles = [box('a', -190, -39), box('b', 400, 161), box('medio', 150, 70)];
    const points = route({ x: 0, y: 0 }, { x: 400, y: 200 }, obstacles, ends);
    expect(points).toHaveLength(3);
    expect(clear(points, obstacles, ends)).toBe(true);
  });

  it('goes out to the side when both corners are blocked', () => {
    const obstacles = [
      box('a', -190, -39), box('b', -190, 361),
      box('medio', -95, 161), // straight down the middle
    ];
    const points = route({ x: 0, y: 0 }, { x: 0, y: 400 }, obstacles, ends);
    expect(points.length).toBeGreaterThan(2);
    expect(clear(points, obstacles, ends)).toBe(true);
  });

  it('never treats its own two ends as obstacles', () => {
    const obstacles = [box('a', 0, 0), box('b', 400, 0)];
    expect(route({ x: 190, y: 39 }, { x: 400, y: 39 }, obstacles, ends)).toHaveLength(2);
  });

  it('takes the least bad way round when nothing is clear, and never a diagonal', () => {
    // Walled in: every channel the router tries is covered.
    const wall = Array.from({ length: 40 }, (_, i) => box(`w${i}`, 150, -900 + i * 60, 190, 60));
    const obstacles = [box('a', -190, -39), box('b', 400, -39), ...wall];
    /*
     * The two ends are not aligned, so the plain answer would be a diagonal cutting across
     * the drawing — which reads as a mistake even when it is the shortest way. What comes
     * back is right angles, and the composition pass is what says it crossed something.
     */
    const points = route({ x: 0, y: 0 }, { x: 400, y: 240 }, obstacles, ends);
    expect(clear(points, obstacles, ends)).toBe(false);
    for (let i = 0; i + 1 < points.length; i++) {
      const square = points[i].x === points[i + 1].x || points[i].y === points[i + 1].y;
      expect(square, `${JSON.stringify(points[i])} → ${JSON.stringify(points[i + 1])}`).toBe(true);
    }
  });
});

describe('labelAt', () => {
  it('sits in the middle of the longest stretch, where there is most room', () => {
    expect(labelAt([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 400 }])).toEqual({ x: 20, y: 200 });
  });

  it('is the midpoint of a straight line', () => {
    expect(labelAt([{ x: 0, y: 0 }, { x: 100, y: 0 }])).toEqual({ x: 50, y: 0 });
  });
});
