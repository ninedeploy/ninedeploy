import {beforeEach,describe,it,expect,vi} from 'vitest';
import {fireEvent,screen,waitFor} from '@testing-library/react';
import {DatabaseDetail} from '../src/routes/DatabaseDetail.js';
import {api} from '../src/lib/api.js';
import {mockOf,renderRoute} from './helpers.js';
vi.mock('../src/lib/api.js',async()=>{const {createFakeApiModule}=await import('./apiMock.js');return {...createFakeApiModule(),authedFetch:vi.fn()};});
vi.mock('../src/lib/auth.js',()=>({AuthProvider:({children}:{children:React.ReactNode})=><>{children}</>,useAuth:()=>({user:{id:1,isOperator:true},loading:false})}));
vi.mock('../src/components/terminal/TerminalPanel.js',()=>({TerminalPanel:({target,title}:{target:unknown;title:string})=><section aria-label="Database client terminal"><h2>{title}</h2><pre data-testid="client-target">{JSON.stringify(target)}</pre></section>}));
const database={id:13,projectId:null,name:'orders',slug:'orders',engine:'postgres',version:'18',status:'running',host:'nd-db-orders',port:5432,username:'nine',database:'app',connectionString:null,containerName:'nd-db-orders',volumeName:'nd-db-orders-data',cpuShares:0,cpuLimitMilli:0,memLimitMb:0,webGuiEnabled:false,webGuiPort:null,attachedServices:[],extensions:[],createdAt:'2026-10-23T00:00:00Z',updatedAt:'2026-10-23T00:00:00Z'};
beforeEach(()=>{
  vi.clearAllMocks();
  mockOf(api.databases.credentials).mockResolvedValue({} as never);
  mockOf(api.databases.stopStudio).mockResolvedValue({ok:true});
  mockOf(api.databases.startStudio).mockResolvedValue({ok:true,port:null,serverId:7,url:'/v1/databases/13/studio-proxy/'});
});

describe('node database Studio controls', () => {
  it('launches through the panel URL, shows the recorded node and never fabricates a host port', async () => {
    mockOf(api.databases.get).mockResolvedValue({...database,serverId:7,serverName:'edge-7',reachable:true} as never);
    const open = vi.spyOn(window,'open').mockReturnValue(null);
    try {
      renderRoute(<DatabaseDetail/>,{path:'/databases/:id',route:'/databases/13'});
      fireEvent.click(await screen.findByRole('button',{name:'Launch Web Studio'}));
      await waitFor(()=>expect(api.databases.startStudio).toHaveBeenCalledWith(13));
      await waitFor(()=>expect(open).toHaveBeenCalledWith(expect.stringContaining('/v1/databases/13/studio-proxy/'),'_blank','noopener,noreferrer'));
      expect(screen.getByText(/Runs on node #7/)).toBeInTheDocument(); expect(screen.queryByText(/Running on :/)).not.toBeInTheDocument();
      expect(document.querySelector('iframe')).toBeNull();
    } finally { open.mockRestore(); }
  });
  it.each(['preparing','cleanup_pending'] as const)('offers cleanup for a persisted %s operation even while the database is stopped', async state => {
    mockOf(api.databases.get).mockResolvedValue({...database,status:'stopped',serverId:7,serverName:'edge-7',nodeStudioState:state} as never);
    renderRoute(<DatabaseDetail/>,{path:'/databases/:id',route:'/databases/13'});
    const stop=await screen.findByRole('button',{name:'Stop Studio'}); expect(stop).toBeEnabled();
    expect(screen.getByRole('button',{name:'Launch Web Studio'})).toBeDisabled();
    fireEvent.click(stop);await waitFor(()=>expect(api.databases.stopStudio).toHaveBeenCalledWith(13));
  });
  it('shows a running node Studio without inventing a panel-host port', async()=>{
    mockOf(api.databases.get).mockResolvedValue({...database,serverId:7,webGuiEnabled:true,nodeStudioState:'ready'} as never);
    renderRoute(<DatabaseDetail/>,{path:'/databases/:id',route:'/databases/13'});
    expect(await screen.findByText('Running on node #7')).toBeInTheDocument(); expect(screen.getByRole('button',{name:'Open studio'})).toBeEnabled();
    expect(screen.queryByText(/Running on :/)).not.toBeInTheDocument();
  });
  it.each(['mongo','clickhouse','meilisearch','rabbitmq'])('does not advertise an unsupported %s Studio', async engine=>{
    mockOf(api.databases.get).mockResolvedValue({...database,engine,serverId:7} as never);
    renderRoute(<DatabaseDetail/>,{path:'/databases/:id',route:'/databases/13'});
    expect(await screen.findByText(/Web Studio supports PostgreSQL/)).toBeInTheDocument(); expect(screen.queryByRole('button',{name:'Launch Web Studio'})).not.toBeInTheDocument();
  });
});
