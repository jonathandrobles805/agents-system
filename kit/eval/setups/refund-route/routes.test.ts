import { describe, it, expect } from 'vitest';
import { PaymentService } from '../src/domain/payment';
import { routes } from '../src/api/routes';
describe('routes', () => {
  it('routes exposes refund, delegating to the service', async () => {
    const s = new PaymentService({ charge: async () => 5, refund: async () => 7 });
    expect(await (routes(s) as { refund?: (id: string) => Promise<number> }).refund?.('r1')).toBe(7);
  });
});
