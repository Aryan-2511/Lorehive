import { http } from '@org/http';

/** FX rates client, as an agent might write it. */
export async function getRate(base: string, quote: string): Promise<number> {
  const res = await http.get(`https://fx.example.com/rates/${base}/${quote}`);
  return res.data.rate;
}
