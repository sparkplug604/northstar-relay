import {Zone,FixedOffsetZone} from 'luxon';
import moment from 'moment-timezone';

/** Use packaged IANA rules so scheduling does not depend on the host ICU release. */
class DispatchZone extends Zone {
  constructor(private readonly zoneName:string){super();}
  override get type(){return 'iana';}
  override get name(){return this.zoneName;}
  override get isUniversal(){return false;}
  override get isValid(){return moment.tz.zone(this.zoneName)!==null;}
  override offset(timestamp:number){return -(moment.tz.zone(this.zoneName)?.utcOffset(timestamp)??NaN);}
  override offsetName(timestamp:number){return moment.tz.zone(this.zoneName)?.abbr(timestamp)??null;}
  override formatOffset(timestamp:number,format:'short'|'narrow'|'techie'){return FixedOffsetZone.instance(this.offset(timestamp)).formatOffset(timestamp,format);}
  override equals(other:Zone){return other.type===this.type&&other.name===this.name;}
}
const zones=new Map<string,DispatchZone>();
export function dispatchZone(name:string):Zone {
  let zone=zones.get(name);
  if(!zone){zone=new DispatchZone(name);zones.set(name,zone);}
  return zone;
}
