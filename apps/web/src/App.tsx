import { lazy, Suspense, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { Compass } from 'lucide-react';
import { Layout } from './components/Layout.js';
import { Button, Card, EmptyState, FullScreenSpinner } from './components/ui.js';
import { useAuth } from './lib/auth.js';
import { WorkspaceProvider } from './lib/workspace.js';
import { TagScopeProvider } from './lib/projects.js';
import { ModeProvider } from './lib/mode.js';

/**
 * Every route is code-split. The landing bundle carries only the shell
 * (router, providers, layout); each page — with its charts, terminals and
 * wizards — is fetched on first navigation. Before this, the single index
 * chunk shipped all 30+ routes to every first paint (~1 MB raw).
 */
const Login = lazy(() => import('./routes/Login.js').then((m) => ({ default: m.Login })));
const ForgotPassword = lazy(() => import('./routes/ForgotPassword.js').then((m) => ({ default: m.ForgotPassword })));
const ResetPassword = lazy(() => import('./routes/ResetPassword.js').then((m) => ({ default: m.ResetPassword })));
const AcceptInvite = lazy(() => import('./routes/AcceptInvite.js').then((m) => ({ default: m.AcceptInvite })));
const Monitoring = lazy(() => import('./routes/Monitoring.js').then((m) => ({ default: m.Monitoring })));
const About = lazy(() => import('./routes/About.js').then((m) => ({ default: m.About })));
const Backups = lazy(() => import('./routes/Backups.js').then((m) => ({ default: m.Backups })));
const Dashboard = lazy(() => import('./routes/Dashboard.js').then((m) => ({ default: m.Dashboard })));
const Databases = lazy(() => import('./routes/Databases.js').then((m) => ({ default: m.Databases })));
const DatabaseDetail = lazy(() => import('./routes/DatabaseDetail.js').then((m) => ({ default: m.DatabaseDetail })));
const Domains = lazy(() => import('./routes/Domains.js').then((m) => ({ default: m.Domains })));
const Hub = lazy(() => import('./routes/Hub.js').then((m) => ({ default: m.Hub })));
const ManifestCreator = lazy(() => import('./routes/ManifestCreator.js').then((m) => ({ default: m.ManifestCreator })));
const ServiceDetail = lazy(() => import('./routes/service/index.js').then((m) => ({ default: m.ServiceDetail })));
const ServicesList = lazy(() => import('./routes/ServicesList.js').then((m) => ({ default: m.ServicesList })));
const Servers = lazy(() => import('./routes/Servers.js').then((m) => ({ default: m.Servers })));
const Settings = lazy(() => import('./routes/settings/index.js').then((m) => ({ default: m.Settings })));
const Sources = lazy(() => import('./routes/Sources.js').then((m) => ({ default: m.Sources })));
const Topology = lazy(() => import('./routes/Topology.js').then((m) => ({ default: m.Topology })));
const Tunnels = lazy(() => import('./routes/Tunnels.js').then((m) => ({ default: m.Tunnels })));
const Users = lazy(() => import('./routes/Users.js').then((m) => ({ default: m.Users })));
const Workspaces = lazy(() => import('./routes/Workspaces.js').then((m) => ({ default: m.Workspaces })));
const Volumes = lazy(() => import('./routes/Volumes.js').then((m) => ({ default: m.Volumes })));
const Networks = lazy(() => import('./routes/Networks.js').then((m) => ({ default: m.Networks })));
const DockerDashboard = lazy(() => import('./routes/Docker.js').then((m) => ({ default: m.DockerDashboard })));
const Traefik = lazy(() => import('./routes/Traefik.js').then((m) => ({ default: m.Traefik })));
const Activity = lazy(() => import('./routes/Activity.js').then((m) => ({ default: m.Activity })));
const Projects = lazy(() => import('./routes/Projects.js').then((m) => ({ default: m.Projects })));
const Labels = lazy(() => import('./routes/Labels.js').then((m) => ({ default: m.Labels })));
const Deploys = lazy(() => import('./routes/Deploys.js').then((m) => ({ default: m.Deploys })));
const Doctor = lazy(() => import('./routes/Doctor.js').then((m) => ({ default: m.Doctor })));

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** Wildcard fallback for unknown paths. */
function NotFound() {
  return (
    <Card>
      <EmptyState
        icon={<Compass size={26} />}
        title="Not found"
        hint="The page you are looking for does not exist."
        action={<Link to="/"><Button size="sm">Back to dashboard</Button></Link>}
      />
    </Card>
  );
}

export default function App() {
  const { loading } = useAuth();
  if (loading) return <FullScreenSpinner />;

  return (
    // The Suspense boundary IS the navigation loading state: while a route
    // chunk is being fetched, the previous view is swapped for the spinner.
    <Suspense fallback={<FullScreenSpinner />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        {/* Public invitation accept — shown to anonymous visitors and
            authenticated users alike; the page itself routes them through
            login/register if they are not yet a member. */}
        <Route path="/invite/:token" element={<AcceptInvite />} />
        <Route
          element={
            <RequireAuth>
              <WorkspaceProvider>
                <ModeProvider>
                  <TagScopeProvider>
                    <Layout />
                  </TagScopeProvider>
                </ModeProvider>
              </WorkspaceProvider>
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="dashboard" element={<Navigate to="/" replace />} />
          <Route path="workspaces" element={<Workspaces />} />
          <Route path="projects" element={<Projects />} />
          <Route path="labels" element={<Labels />} />
          <Route path="services" element={<ServicesList />} />
          <Route path="hub" element={<Hub />} />
          <Route path="manifest-creator" element={<ManifestCreator />} />
          <Route path="deploys" element={<Deploys />} />
          <Route path="doctor" element={<Doctor />} />
          <Route path="databases" element={<Databases />} />
          <Route path="domains" element={<Domains />} />
          <Route path="tunnels" element={<Tunnels />} />
          <Route path="users" element={<Users />} />
          <Route path="volumes" element={<Volumes />} />
          <Route path="networks" element={<Networks />} />
          <Route path="docker" element={<DockerDashboard />} />
          <Route path="topology" element={<Topology />} />
          <Route path="backups" element={<Backups />} />
          <Route path="sources" element={<Sources />} />
          <Route path="servers" element={<Servers />} />
          <Route path="settings" element={<Settings />} />
          <Route path="about" element={<About />} />
          <Route path="monitoring" element={<Monitoring />} />
          <Route path="activity" element={<Activity />} />
          <Route path="traefik" element={<Traefik />} />
          <Route path="services/:id" element={<ServiceDetail />} />
          <Route path="databases/:id" element={<DatabaseDetail />} />
          {/*
            The catch-all lives INSIDE the Layout so an unknown path
            inside the authed area still shows the sidebar (the second
            group is the default landing pad — see Layout.tsx) instead of
            dropping the user onto a bare "Not found" page. Anything that
            resolves before the authed parent (e.g. /login, /invite/:token)
            still routes normally.
          */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
