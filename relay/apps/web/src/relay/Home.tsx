import {HomeTriage} from './AskRelay.js';
import {canDispatch,type Session} from './api.js';
import {dateLabel,tr,type Language} from './i18n.js';
import {ux} from './ux.js';
import {useOverview} from './useOverview.js';
import {useJobs,useJobsOverview} from './useJobs.js';
import {jobEventLabel,jt} from './jobsI18n.js';
import {jobPath} from './jobsModel.js';
import {withReturnTo} from './navigation.js';

const attentionPath = '/relay/jobs?filter=attention';
const plainFlags: Record<string,string> = {unassigned:'No one assigned', missed_start:'Job did not start on time', acknowledgement_unowned:'Waiting for someone to accept', acknowledgement_overdue:'No one accepted on time', delivery_problem:'Trouble reaching the team', blocked:'Work can’t continue', completion_review:'Waiting for you to confirm it’s done', overdue_commitment:'A job task is overdue'};

const iconPaths = {
  jobs: 'M4 7h16v13H4z M9 7V4h6v3 M4 12h16',
  assigned: 'M16 21H4v-2a4 4 0 0 1 4-4h4 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M15 17l2 2 4-5',
  clock: 'M12 8v5l3 2 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20',
  attention: 'M12 3l10 18H2z M12 9v4 M12 17h.01',
  review: 'M8 4h8v4H8z M8 6H5v15h14V6h-3 M8 14l2 2 5-5',
  intake: 'M4 4h16l2 11v5H2v-5z M2 15h6l2 3h4l2-3h6',
};

function HomeIcon({name}:{name:keyof typeof iconPaths}) {
  return <svg className="relay-home-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]}/></svg>;
}

export function Home({session,language,navigate}:{session:Session;language:Language;navigate(path:string):void}) {
  const overview = useOverview(session);
  const jobs = useJobsOverview(session);
  const attention = useJobs(session, 'filter=attention');
  const j = (key:Parameters<typeof jt>[1]) => jt(language,key);
  const t = (key:Parameters<typeof tr>[1]) => tr(language,key);
  const u = (key:Parameters<typeof ux>[1]) => ux(language,key);
  const fr = language === 'fr';
  const review = canDispatch(session);
  const company = session.organization.name.replace(/ · Synthetic Demo$/, '');
  const count = attention.data?.total ?? jobs.data?.attention;
  const refreshing = jobs.loading || attention.loading || (review && overview.loading);
  const attentionTitle = count === undefined
    ? j('attention')
    : fr ? `${count} ${count === 1 ? 'travail à traiter' : 'travaux à traiter'}`
      : `${count} ${count === 1 ? 'job to check' : 'jobs to check'}`;

  function refresh() {
    window.dispatchEvent(new Event('relay-priorities-refresh'));
    void jobs.refresh();
    void attention.refresh();
    void overview.refresh();
  }

  return <div className="relay-home">
    <h1 className="relay-sr-only">{u('home')}</h1>
    <div className="relay-home-signin">
      {session.user.email === 'dispatch@relay-demo.invalid'
          ? <img className="relay-avatar relay-drew-portrait" src="/drew-dispatcher.svg" alt=""/>
          : <span className="relay-avatar" aria-hidden="true">{session.user.displayName.slice(0,1)}</span>}
      <span>{fr ? 'Connecté en tant que' : 'Logged in as'} <strong>{session.user.displayName}</strong> {fr ? 'pour' : 'for'} <strong>{company}</strong></span>
    </div>
    {jobs.error != null && <p role="alert" className="relay-warning">{u(jobs.data?'refreshHelp':'unknown')}</p>}
    <section className="relay-home-meta" aria-label={u('summary')}>
      {jobs.data && <>
      <button className="relay-text-button" type="button" onClick={()=>navigate('/relay/jobs')}><HomeIcon name="jobs"/><span><strong>{jobs.data.active}</strong> {j('activeJobs')}</span></button>
      <button className="relay-text-button" type="button" onClick={()=>navigate('/relay/jobs?filter=mine')}><HomeIcon name="assigned"/><span><strong>{jobs.data.mine}</strong> {j('mine')}</span></button>
      {session.user.role==='on_call_responder' && <button className="relay-text-button" type="button" onClick={()=>navigate('/relay/commitments?filter=mine')}>{j('myCommitments')}</button>}
      </>}
      <div className="relay-home-refresh">
        <button className="relay-text-button" type="button" disabled={refreshing} onClick={refresh}>{t(refreshing?'loading':'refresh')}</button>
        {jobs.data && <small><HomeIcon name="clock"/><span>{u('latest')}: <time dateTime={jobs.data.asOf}>{dateLabel(language,jobs.data.asOf)}</time></span></small>}
      </div>
    </section>
    {review&&session.providerMode==='simulated'&&window.location.origin==='http://127.0.0.1:3004'?<HomeTriage/>:<>
    <section className="relay-card relay-home-attention" aria-labelledby="home-attention-title">
      <div className="relay-home-group-heading">
        <div><h2 id="home-attention-title"><HomeIcon name="attention"/>{attentionTitle}</h2>
          <p>{fr ? 'Travaux signalés à examiner, par exemple un blocage, un départ manqué ou un engagement en retard.' : 'See what’s holding up a job or what still needs to be done.'}</p>
        </div>
        <button type="button" className="relay-text-button" onClick={()=>navigate(attentionPath)}>
          {count === undefined ? (fr ? 'Ouvrir la file' : 'Open attention queue') : (fr ? `Tout afficher (${count})` : `View all ${count}`)}
        </button>
      </div>
      {attention.error != null && <p className="relay-warning" role="alert">{u(attention.data?'refreshHelp':'unknown')}</p>}
      {!attention.data && attention.loading && <p role="status">{t('loading')}</p>}
      {attention.data && attention.data.items.length === 0 && <p>{fr ? 'Aucun travail ne nécessite votre attention.' : 'No jobs need attention.'}</p>}
      {attention.data && attention.data.items.length > 0 && <ul className="relay-home-queue" aria-label={fr ? 'Dernières mises à jour' : 'Recently updated jobs'}>
        {attention.data.items.slice(0,3).map(job => {
          const flags = job.attentionReasons ?? [];
          const blocker = job.status === 'blocked' ? job.blocker?.trim() : '';
          const missedStart = flags.includes('missed_start') ? job.scheduledAt : null;
          const remaining = flags.filter(reason =>
            !(reason === 'blocked' && blocker) &&
            !(reason === 'missed_start' && missedStart) &&
            !(reason === 'acknowledgement_unowned' && flags.includes('acknowledgement_overdue')));
          return <li key={job.id}>
            <button type="button" className="relay-text-button relay-home-job-link" onClick={()=>navigate(withReturnTo(jobPath(job.id),attentionPath))}>{job.customerReference || job.externalId}</button>
            {blocker && <p className="relay-home-blocker"><strong>{fr ? 'Bloqué' : 'Blocked'}:</strong> {blocker}</p>}
            {missedStart && <p><strong>{fr ? 'Départ manqué' : 'Missed start'}:</strong> <time dateTime={missedStart}>{dateLabel(language,missedStart)}</time></p>}
            {remaining.length > 0 && <p>{remaining.map(reason=>fr ? jobEventLabel(language,reason) : plainFlags[reason] ?? jobEventLabel(language,reason)).join(' · ')}</p>}
            {job.customerReference && <small>{fr ? 'Réf.' : 'Ref.'} {job.externalId}</small>}
          </li>;
        })}
      </ul>}
    </section>
    </>}
    {review && <section className="relay-card relay-home-review-group" aria-labelledby="home-review-title">
      <h2 id="home-review-title"><HomeIcon name="review"/>{fr ? 'À vérifier' : 'Waiting for your decision'}</h2><p className="relay-home-review-note">{fr ? 'Décisions en attente. Les fins de travaux peuvent aussi figurer ci-dessus.' : 'Check finished jobs and new requests. A finished job can also show up above.'}</p>
      {overview.error && <p className="relay-warning" role="status">{j('inbox')}: {u(overview.data?'refreshHelp':'unknown')}</p>}
      <div className="relay-home-review-rows">
        <button type="button" onClick={()=>navigate('/relay/jobs?status=completion_reported')}><span><HomeIcon name="review"/>{fr ? 'Confirmer les fins de travaux' : 'Confirm finished jobs'}</span><strong>{jobs.data?.completionReview ?? '—'} →</strong></button>
        <button type="button" onClick={()=>navigate('/relay/intake')}><span><HomeIcon name="intake"/>{fr ? 'Examiner les nouvelles demandes' : 'Check new requests'}</span><strong>{overview.data?.counts.review ?? '—'} →</strong></button>
      </div>
    </section>}
    <div className="relay-home-links"><button className="relay-text-button" type="button" onClick={()=>navigate('/relay/on-call')}>{t('onCall')}</button>{review&&<button className="relay-text-button" type="button" onClick={()=>navigate('/relay/people')}>{t('people')}</button>}<button className="relay-text-button" type="button" onClick={()=>navigate('/relay/history')}>{j('ackHistory')}</button></div>
  </div>;
}
