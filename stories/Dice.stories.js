import { dieSvg } from '../public/dice.js';

export default {
  title: 'Components/Dice',
  argTypes: { size: { control: { type: 'range', min: 32, max: 160, step: 8 } } },
  args: { size: 84 },
  parameters: { layout: 'centered' },
};

const SIDES = [4, 6, 8, 10, 12, 20, 100];

export const AllDice = {
  render: ({ size }) => `<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;color:var(--ink)">${SIDES.map((n) => dieSvg(n, size)).join('')}</div>`,
};

export const D20 = { render: ({ size }) => dieSvg(20, size) };
