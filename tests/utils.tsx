import type { RenderOptions } from "@testing-library/react";
import { render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { AppLayout } from "../src/components/layouts/app-layout";

// Mock ResizeObserver which is not available in test environment
class ResizeObserverMock {
	observe() { }
	unobserve() { }
	disconnect() { }
}

global.ResizeObserver = ResizeObserverMock;

// Create a wrapper component that includes providers
function TestWrapper({ children }: { children: ReactNode }) {
	return <AppLayout>{children}</AppLayout>;
}

// Create a custom render function that includes the wrapper
function customRender(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
	return render(ui, { wrapper: TestWrapper, ...options });
}

// Re-export everything
export * from "@testing-library/react";
export { customRender as render };

