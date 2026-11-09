import type {Language} from './i18n.js';

export function SearchFiltersButton({language,filtersOpen,activeFilters,id,onToggle}:{language:Language;filtersOpen:boolean;activeFilters:number;id:string;onToggle:()=>void}) {
  return <button type="button" className="relay-jobs-search" aria-expanded={filtersOpen} aria-controls={id} onClick={onToggle}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
        <span>{language==='fr'?'Recherche et filtres':'Search & filters'}</span>
        {activeFilters>0&&<small>{language==='fr'?`${activeFilters} en cours`:`${activeFilters} active`}</small>}
    </button>;
}
