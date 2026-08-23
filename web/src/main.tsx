import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import './styles.css';

class WorkbenchErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('DSbot Quant Terminal failed to render', error);
  }

  render() {
    if (this.state.error) {
      return <div className="boot-screen" role="alert"><div><strong>WORKBENCH RENDER FAILED</strong><span>{this.state.error.message}</span><span>Reload once. If this remains, check the browser console and application gateway build.</span></div></div>;
    }
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WorkbenchErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WorkbenchErrorBoundary>
  </React.StrictMode>,
);
