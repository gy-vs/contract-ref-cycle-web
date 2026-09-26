import {describe, expect, it} from 'vitest';
import {RequestSequencer} from '../src/client/request-sequencer';

describe('RequestSequencer – rapid example switching', () => {
  it('invalidates earlier tokens when a newer request starts', () => {
    const sequencer = new RequestSequencer();
    const orders = sequencer.next();
    const profiles = sequencer.next();
    expect(orders.isCurrent()).toBe(false);
    expect(profiles.isCurrent()).toBe(true);
  });

  it('lets only the latest response apply when slow and fast loads finish out of order', async () => {
    const sequencer = new RequestSequencer();
    const applied: string[] = [];
    // Simulates selecting "orders" (240ms preview) then immediately
    // "profiles" (30ms preview): the orders response resolves last.
    await Promise.all(
      [
        {id: 'orders', delay: 60},
        {id: 'profiles', delay: 5},
      ].map(async ({id, delay}) => {
        const token = sequencer.next();
        await new Promise(resolve => setTimeout(resolve, delay));
        if (token.isCurrent()) applied.push(id);
      }),
    );
    expect(applied).toEqual(['profiles']);
  });

  it('applies the sole in-flight request normally', async () => {
    const sequencer = new RequestSequencer();
    const token = sequencer.next();
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(token.isCurrent()).toBe(true);
  });
});
