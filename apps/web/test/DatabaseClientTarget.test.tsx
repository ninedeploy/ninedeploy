import {beforeEach,describe,it,expect,vi} from 'vitest';
import {fireEvent,screen} from '@testing-library/react';
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
});
describe('database client target identity in the panel',()=>{
  it('opens the recorded database resource and keeps its node visible in the terminal title',async()=>{
    mockOf(api.databases.get).mockResolvedValue({...database,serverId:7,serverName:'edge-7',reachable:true} as never);
    renderRoute(<DatabaseDetail/>,{path:'/databases/:id',route:'/databases/13'});
    fireEvent.click(await screen.findByRole('button',{name:'Client'}));
    expect(await screen.findByRole('region',{name:'Database client terminal'})).toHaveTextContent('Node #7 · orders · client');
    expect(screen.getByTestId('client-target')).toHaveTextContent(JSON.stringify({kind:'database',databaseId:13,mode:'client'}));
  });
  it('preserves the panel-host client target and title',async()=>{
    mockOf(api.databases.get).mockResolvedValue({...database,serverId:null,serverName:null,reachable:null} as never);
    renderRoute(<DatabaseDetail/>,{path:'/databases/:id',route:'/databases/13'});
    fireEvent.click(await screen.findByRole('button',{name:'Client'}));
    expect(await screen.findByRole('region',{name:'Database client terminal'})).toHaveTextContent('orders · client');
    expect(screen.queryByText(/Node #/)).not.toBeInTheDocument();
    expect(screen.getByTestId('client-target')).toHaveTextContent(JSON.stringify({kind:'database',databaseId:13,mode:'client'}));
  });
});
