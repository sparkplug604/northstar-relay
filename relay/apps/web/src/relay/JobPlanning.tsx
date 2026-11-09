import {useEffect,useRef,useState} from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGrid from '@fullcalendar/timegrid';
import luxon from '@fullcalendar/luxon3';
import frLocale from '@fullcalendar/core/locales/fr';
import {LngLatBounds,Map,Marker,NavigationControl,Popup,setWorkerUrl} from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import {DateTime,displayTimezone} from './DateTime.js';
import {relayRequest} from './api.js';
import type {TechnicianPlanning} from '@northstar/relay-domain';
import type {EventInput} from '@fullcalendar/core';
import type {Language} from './i18n.js';
import type {Job} from './jobsModel.js';
import './jobPlanning.css';

setWorkerUrl(mapWorkerUrl);

type Props={jobs:Job[];language:Language;name:(id:string|null)=>string;open:(id:string)=>void};
const title=(job:Job)=>job.customerReference||job.externalId;

function JobLinks({jobs,name,open}:Pick<Props,'jobs'|'name'|'open'>){
  return <ul className="relay-planning-jobs">{jobs.map(job=><li key={job.id}>
    <button type="button" className="relay-text-button" onClick={()=>open(job.id)}>{title(job)}</button>
    <small>{[job.site?.label,name(job.assigneeId)].filter(Boolean).join(' · ')}</small>
  </li>)}</ul>;
}

export function JobsMap({jobs,language,name,open,compact=false}:Props&{compact?:boolean}){
  const [selected,setSelected]=useState<string|null>(null);
  const container=useRef<HTMLDivElement>(null),mapRef=useRef<Map|null>(null),openRef=useRef(open);
  const [unavailable,setUnavailable]=useState(false);
  const fr=language==='fr';
  openRef.current=open;
  useEffect(()=>{
    if(!container.current)return;
    let map:Map;
    try{
      map=new Map({container:container.current,center:[-123.12,49.26],zoom:11,
        style:'https://tiles.openfreemap.org/styles/positron'});
    }catch{setUnavailable(true);return;}
    mapRef.current=map;
    map.addControl(new NavigationControl({showCompass:false}),'top-right');
    map.on('error',()=>setUnavailable(true));
    map.on('load',()=>setUnavailable(false));
    const resize=new ResizeObserver(()=>map.resize());
    resize.observe(container.current);
    return ()=>{resize.disconnect();map.remove();mapRef.current=null;};
  },[]);
  useEffect(()=>{
    const map=mapRef.current;
    if(!map)return;
    const bounds=new LngLatBounds();
    const markers=jobs.flatMap(job=>{
      if(!job.site)return [];
      const {longitude,latitude}=job.site;
      const point:[number,number]=[longitude,latitude];
      bounds.extend(point);
      const button=document.createElement('button');
      button.type='button';
      button.className='relay-map-pin';
      button.textContent='●';
      button.title=title(job);
      button.setAttribute('aria-label',title(job));
      button.addEventListener('click',event=>{event.stopPropagation();setSelected(job.id);});
      return [new Marker({element:button}).setLngLat(point).addTo(map)];
    });
    if(markers.length)map.fitBounds(bounds,{padding:65,maxZoom:14,duration:0});
    return ()=>markers.forEach(marker=>marker.remove());
  },[jobs]);
  useEffect(()=>{
    const map=mapRef.current,job=jobs.find(item=>item.id===selected);
    if(!map||!job?.site)return;
    const [client,...parts]=job.customerReference.split(' — ');
    const content=document.createElement('div');
    content.className='relay-map-job-summary';
    const heading=document.createElement('h3');
    heading.textContent=client||job.externalId;
    content.append(heading);
    const repair=document.createElement('p');
    repair.textContent=parts.join(' — ')||job.description||(fr?'Aucun détail sur le travail':'No work details provided');
    content.append(repair);
    const assigned=document.createElement('p');
    assigned.textContent=(fr?'Attribué à':'Assigned to')+' · '+name(job.assigneeId);
    content.append(assigned);
    const action=document.createElement('button');
    action.type='button';
    action.textContent=compact?(fr?'Retour aux détails':'Back to job details'):(fr?'Ouvrir le travail':'Open job');
    action.addEventListener('click',()=>openRef.current(job.id));
    content.append(action);
    const popup=new Popup({maxWidth:'300px',offset:22,closeButton:true})
      .setLngLat([job.site.longitude,job.site.latitude]).setDOMContent(content).addTo(map);
    const closed=()=>setSelected(current=>current===job.id?null:current);
    popup.on('close',closed);
    return ()=>{popup.off('close',closed);popup.remove();};
  },[selected,jobs,name,fr,compact]);
  const located=jobs.filter(job=>job.site),missing=jobs.filter(job=>!job.site);
  return <section className="relay-job-planning" aria-label={fr?'Carte des travaux':'Job map'}>
    <div ref={container} className={compact?"relay-jobs-map relay-job-site-map":"relay-jobs-map"} aria-label={fr?'Emplacements des travaux':'Job sites'}/>
    {unavailable&&<p role="status">{fr?'Le fond de carte est indisponible. Les travaux sont listés ci-dessous.':'The basemap is unavailable. The job location is listed on this page.'}</p>}
    {!compact&&located.length>0&&<><h2>{fr?'Travaux sur la carte':'Jobs on the map'}</h2><JobLinks jobs={located} name={name} open={open}/></>}
    {!compact&&missing.length>0&&<><h2>{fr?'Emplacement manquant':'Missing location'}</h2><JobLinks jobs={missing} name={name} open={open}/></>}
  </section>;
}

export function JobsCalendar({jobs,language,name,open,owner,people,onOwner,dispatch=false}:Props&{
  dispatch?:boolean;owner:string;people:{id:string;displayName:string}[];onOwner:(id:string)=>void;
}){
  const fr=language==='fr';
  const calendar=useRef<FullCalendar|null>(null);
  const [availability,setAvailability]=useState<TechnicianPlanning|null>(null),[availabilityError,setAvailabilityError]=useState('');
  useEffect(()=>{
    setAvailability(null);setAvailabilityError('');
    if(!owner||!dispatch)return;
    const controller=new AbortController();
    void relayRequest<{items:TechnicianPlanning[]}>('/technicians',{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setAvailability(result.items.find(person=>person.personId===owner)??null);})
      .catch(()=>{if(!controller.signal.aborted)setAvailabilityError(fr?'Impossible de charger la disponibilité.':'Could not load working hours and time off.');});
    return ()=>controller.abort();
  },[owner,dispatch,fr]);
  const events:EventInput[]=jobs.flatMap(job=>{
    if(!job.scheduledAt)return [];
    const minutes=job.estimatedMinutes;
    return [{id:job.id,title:`${title(job)} · ${name(job.assigneeId)}${minutes?'':fr?' · Heure de début seulement':' · Start time only'}`,
      start:job.scheduledAt,...(minutes?{end:new Date(Date.parse(job.scheduledAt)+minutes*60000).toISOString()}:{}),
      display:minutes?'block':'list-item',url:'#job-'+job.id}];
  });
  const timeOff:EventInput[]=(availability?.profile?.timeOff??[]).map((period,index)=>({
    id:'time-off-'+index,start:period.start,end:period.end,display:'background',backgroundColor:'#f6c8c3',
    title:fr?'Congé':'Time off',
  }));
  const businessHours=availability?.profile?.workingHours.map(period=>({
    daysOfWeek:[period.weekday%7],startTime:period.start,endTime:period.end,
  }))??[];
  const upcoming=jobs.filter(job=>job.scheduledAt&&Date.parse(job.scheduledAt)>=Date.now())
    .sort((a,b)=>Date.parse(a.scheduledAt!)-Date.parse(b.scheduledAt!)).slice(0,3);
  const unscheduled=jobs.filter(job=>!job.scheduledAt);
  return <section className="relay-job-planning" aria-label={fr?'Calendrier des travaux':'Job calendar'}>
    <div className="relay-calendar-person"><label htmlFor="relay-calendar-technician">{fr?'Technicien':'Technician'}</label> <select id="relay-calendar-technician" value={owner} onChange={event=>onOwner(event.target.value)}>
      <option value="">{fr?'Tous les techniciens':'All technicians'}</option>
      {people.map(person=><option key={person.id} value={person.id}>{person.displayName}</option>)}
    </select></div>
    {upcoming.length>0&&<section className="relay-card" aria-label={fr?'Prochaines visites':'Upcoming visits'}>
      <h2>{fr?'Prochaines visites':'Upcoming visits'}</h2>
      <ul className="relay-planning-jobs">{upcoming.map(job=><li key={job.id}>
        <strong>{title(job).split(' — ')[0]}</strong>
        <p><DateTime value={job.scheduledAt} language={language}/></p><p>{name(job.assigneeId)}</p>
        <button type="button" onClick={()=>{calendar.current?.getApi().gotoDate(job.scheduledAt!);calendar.current?.getApi().scrollToTime('08:00:00');}}>
          {fr?'Afficher au calendrier':'Show in calendar'}</button>
      </li>)}</ul>
    </section>}
    <p>{fr?'Fuseau horaire du calendrier':'Calendar timezone'} · <strong>{availability?.profile?.timezone??displayTimezone()}</strong></p>
    {availabilityError&&<p role="status">{availabilityError}</p>}
    {availability?.profile&&<p>{fr?'Compétences':'Skills'} · <strong>{availability.profile.skills.join(', ')||(fr?'Non enregistrées':'Not recorded')}</strong></p>}
    {availability?.profile&&<p>{fr?'Heures de travail en clair, congés en rouge pâle':'Working hours are clear. Time off is shaded red'} · {availability.profile.timezone}</p>}
    {availability&&!availability.profile&&<p>{fr?'Disponibilité non enregistrée':'Working hours and time off have not been recorded.'}</p>}
    {!owner&&dispatch&&<p>{fr?'Choisissez un technicien pour afficher ses heures et congés.':'Choose a technician to see working hours and time off.'}</p>}
    <div className="relay-calendar-scroll"><FullCalendar ref={calendar}
      plugins={[timeGrid,luxon]} locale={fr?frLocale:'en'} timeZone={availability?.profile?.timezone??displayTimezone()} businessHours={businessHours.length?businessHours:false}
      initialView="timeGridWeek" headerToolbar={{left:'prev,next today',center:'title',right:'timeGridDay,timeGridWeek'}}
      buttonText={{day:fr?'Jour':'Day',week:fr?'Semaine':'Week',today:fr?'Aujourd’hui':'Today'}}
      allDaySlot={false} nowIndicator scrollTime="07:30:00" height={590}
      events={[...events,...timeOff]} eventClick={event=>{event.jsEvent.preventDefault();if(event.event.display!=='background')open(event.event.id);}}
    /></div>
    {events.length===0&&<p>{fr?'Aucune visite planifiée pour ces filtres.':'No scheduled visits match these filters.'}</p>}
    {unscheduled.length>0&&<><h2>{fr?'Travaux non planifiés':'Unscheduled jobs'}</h2><JobLinks jobs={unscheduled} name={name} open={open}/></>}
  </section>;
}
