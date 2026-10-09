import type { HelpTopic } from '../types.js';

/**
 * Multi-node topics (the "0.16" theme, shipped in the 0.15.x series): node
 * agents and roles, build placement and image transfer, Swarm, and the
 * databases, volumes and Git credentials that live on nodes.
 */
export const MULTI_NODE_TOPICS: Record<string, HelpTopic> = {
  'servers.multi-node': {
    title: 'Nodes: agent, build server, Swarm',
    summary:
      'Each node row on the Servers page shows what its agent can do, whether it builds images for other services, whether it is in the swarm, and how many managed databases it hosts.',
    sections: [
      {
        heading: 'Agent and features',
        bullets: [
          'Version is the agent release the node last reported; "not checked yet" means it has not answered a sealed ping since the panel upgraded.',
          'The feature chips are Nixpacks, Railpack, private clones, volumes, databases, image transfer and Swarm. A struck-through chip is a feature the agent does not offer: the hint under it names them. Update the agent on that node to get them.',
          'Node agents update separately from the panel. A request that needs a newer agent is refused with "update the agent" and changes nothing.',
        ],
      },
      {
        heading: 'Build server',
        steps: [
          'Turn the Build server switch on for a node with spare CPU and disk.',
          'Set how many builds it runs at once (1 to 8).',
          'On a service, set Settings → Build placement → Build on to "A build server" and pick the node.',
        ],
        tip: 'Turning the role off does not move anything: services that still build there fail their next deploy until you change their Build on.',
      },
      {
        heading: 'Swarm membership',
        bullets: [
          'Joining is opt-in on the node: its owner sets NINEDEPLOY_AGENT_SWARM_MANAGER=<advertise address>:2377 in the agent environment and restarts it. Until then Join is refused with the exact line to add.',
          'Leave drains the node first, so its Swarm tasks move to the other members. It can take a few minutes.',
          'A node in the swarm cannot be removed: make it leave first. A node that hosts managed databases cannot be removed either.',
        ],
      },
    ],
    related: [
      { label: 'Servers', helpId: 'servers' },
      { label: 'Settings · Swarm', helpId: 'settings.swarm' },
      { label: 'Build placement', helpId: 'service.build-placement' },
    ],
  },

  'service.build-placement': {
    title: 'Build placement and image transfers',
    summary:
      'Where a docker service is built, and how the image reaches the host that runs it. The default builds where the service runs, exactly as before.',
    sections: [
      {
        heading: 'Build on',
        bullets: [
          'Where the service runs: the default; a node service builds on its node.',
          'This panel host: build on the panel and hand the image to the node. Git credentials never leave the panel.',
          'A build server: build on a node whose Build server role is on (Servers page).',
        ],
      },
      {
        heading: 'How the image travels',
        body: [
          'By default the image streams from the build host to the target through the panel, sealed and checked against its digest. With a push registry (a registry source and a repository such as team/app) the build host pushes it and the target pulls it instead.',
        ],
        tip: 'The transfer history lists the last 20 moves with their size, duration and any error.',
      },
    ],
    related: [
      { label: 'Service · Settings', helpId: 'service.settings' },
      { label: 'Nodes: agent, build server, Swarm', helpId: 'servers.multi-node' },
    ],
  },

  'service.swarm': {
    title: 'Running a service on Swarm',
    summary:
      'The "Orchestrator: Swarm" switch runs a docker service as a Swarm stack, spread across the panel host and the nodes in the swarm, behind Traefik.',
    sections: [
      {
        heading: 'What can run on Swarm',
        bullets: [
          'Docker services from an image or a repository, not pinned to a node.',
          'No persistent volumes or volume attachments, no published host ports, no Docker socket, no managed databases and no fan-out targets.',
          'When the panel refuses the switch, its reason is shown under it. Fix that, or keep plain containers.',
        ],
      },
      {
        heading: 'Swarm tasks',
        body: [
          'While a service is on Swarm, the Swarm tasks card shows how many replicas run, on which node, in which state, and the last task error.',
        ],
        tip: 'Switching back to plain containers is always allowed: the next deploy starts the container, then removes the stack.',
      },
    ],
    related: [
      { label: 'Settings · Swarm', helpId: 'settings.swarm' },
      { label: 'Service · Settings', helpId: 'service.settings' },
    ],
  },

  'settings.swarm': {
    title: 'Settings · Swarm',
    summary:
      'Initialise Docker Swarm on the panel host, switch Swarm deploys on or off, and see the cluster. The panel host is the only manager; nodes join as workers.',
    sections: [
      {
        heading: 'Setting it up',
        steps: [
          'Initialise Swarm with the address the nodes reach the panel host on, and confirm your password.',
          'Enable Swarm deploys (your password is asked again).',
          'On each node, its owner sets NINEDEPLOY_AGENT_SWARM_MANAGER to the manager address shown here, then you press Join on the Servers page.',
          'Switch a service to Swarm under Service → Settings → Runtime orchestrator.',
        ],
      },
      {
        heading: 'Firewall',
        bullets: [
          '2377/tcp: cluster management, on the manager.',
          '7946/tcp and 7946/udp: node gossip.',
          '4789/udp: overlay network traffic.',
          'ESP (IP protocol 50): encrypted overlays.',
        ],
        tip: 'Open these only between the cluster\'s own hosts. Swarm services use encrypted overlay networks, which Docker does not support on Windows hosts.',
      },
    ],
    related: [
      { label: 'Nodes: agent, build server, Swarm', helpId: 'servers.multi-node' },
      { label: 'Running a service on Swarm', helpId: 'service.swarm' },
    ],
  },

  'database.on-nodes': {
    title: 'Databases on nodes',
    summary:
      'An operator can create a managed database on a node whose agent can host databases. It stays on that node for its whole life.',
    sections: [
      {
        heading: 'What works',
        bullets: [
          'Create, start, stop, restart, logs, backups and their policies, restore, import and the terminal.',
          'Services attach to it from the same node only.',
          'The node badge shows where it runs; reachable / unreachable is the node\'s last probe.',
        ],
      },
      {
        heading: 'Not available yet',
        bullets: [
          'Web Studio, PgBouncer and public access: each needs a port on the node and a proxy path through the panel.',
          'Re-attaching a retained volume, and moving a database between hosts. To move one: back it up, create it on the other host, restore.',
        ],
      },
    ],
    related: [
      { label: 'Databases', helpId: 'databases' },
      { label: 'Nodes: agent, build server, Swarm', helpId: 'servers.multi-node' },
    ],
  },

  'volumes.on-nodes': {
    title: 'Volumes on nodes',
    summary: 'The host switcher on the Volumes page lists, creates and deletes managed volumes on a node through its agent.',
    sections: [
      {
        heading: 'Using the host switcher',
        bullets: [
          'Pick a node to see its managed volumes (nd-svc-* and nd-db-*); "Panel host" is the usual inventory.',
          'Create makes a managed volume on the selected host; an existing name is refused.',
          'The file browser and snapshots work on panel-host volumes only.',
          'A node whose agent predates node volumes is listed but cannot be picked: update its agent.',
        ],
      },
    ],
    related: [
      { label: 'Volumes', helpId: 'volumes' },
      { label: 'Nodes: agent, build server, Swarm', helpId: 'servers.multi-node' },
    ],
  },

  'sources.allow-on-nodes': {
    title: 'Allowing a credential on nodes',
    summary:
      'A personal access token or deploy key stays on the panel unless you allow it on nodes. Then a node receives it, sealed, for each clone it runs.',
    sections: [
      {
        heading: 'Before you switch it on',
        bullets: [
          'Turning it on asks for your password again; turning it off never does.',
          'Anyone with root on a node could read the credential while a clone runs there.',
          'Safer options: build on the panel host (Build placement), or use a GitHub App, whose clone tokens are short-lived.',
          'A node owner can refuse every static credential with NINEDEPLOY_AGENT_STATIC_CREDENTIALS=off.',
        ],
      },
    ],
    related: [
      { label: 'Sources', helpId: 'sources' },
      { label: 'Build placement', helpId: 'service.build-placement' },
    ],
  },
};
