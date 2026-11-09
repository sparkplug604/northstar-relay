import {expect,it} from 'vitest';
import {visitInstant} from './dispatch-time.js';
it('moves November 10 to that local day and preserves the existing local visit time',()=>{
 expect(visitInstant('2026-11-10',undefined,'2026-11-09T16:30:00.000Z','America/Vancouver')).toBe('2026-11-10T16:30:00.000Z');
 expect(visitInstant('2026-11-10','18:00',null,'America/Vancouver')).toBe('2026-11-11T01:00:00.000Z');
});
it('requires a time when no prior visit exists and rejects impossible dates',()=>{
 expect(()=>visitInstant('2026-11-10',undefined,null,'America/Vancouver')).toThrow('What time');
 expect(()=>visitInstant('2026-02-30','09:30',null,'America/Vancouver')).toThrow('does not exist');
});
it('does not guess through a nonexistent or ambiguous local clock time',()=>{
 expect(()=>visitInstant('2026-03-08','02:30',null,'America/New_York')).toThrow('does not exist');
 expect(()=>visitInstant('2026-11-01','01:30',null,'America/New_York')).toThrow('occurs twice');
});
