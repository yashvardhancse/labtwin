import { useState } from 'react';
import { ArchitecturePage } from './ArchitecturePage.tsx';
import { TwinController } from './controller.ts';
import { ControllerContext, useHashRoute } from './hooks.ts';
import { ExternalIcon, LogoMark } from './icons.tsx';
import { TwinPage } from './TwinPage.tsx';

/** Set at build time (the deploy workflow passes the GitHub repository URL). */
const REPO_URL = import.meta.env.VITE_REPO_URL;

export function App() {
  const [controller] = useState(() => new TwinController());
  const route = useHashRoute();
  const onArchitecture = route.startsWith('/ros2');

  return (
    <ControllerContext.Provider value={controller}>
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="app-header">
          <a className="brand" href="#/" aria-label="LabTwin home">
            <LogoMark />
            <span className="brand-name">LabTwin</span>
          </a>
          <span className="brand-tagline">Digital twin of a nanolitre sample-prep robot</span>
          <nav className="app-nav" aria-label="Pages">
            <a href="#/" aria-current={onArchitecture ? undefined : 'page'}>
              Twin
            </a>
            <a href="#/ros2" aria-current={onArchitecture ? 'page' : undefined}>
              How it maps to ROS 2
            </a>
          </nav>
          {REPO_URL && (
            <a className="source-link" href={REPO_URL} target="_blank" rel="noreferrer">
              Source <ExternalIcon />
            </a>
          )}
        </header>
        {/* The twin stays mounted (hidden) so a run keeps going while you read the architecture page. */}
        <TwinPage hidden={onArchitecture} />
        {onArchitecture && <ArchitecturePage />}
      </div>
    </ControllerContext.Provider>
  );
}
