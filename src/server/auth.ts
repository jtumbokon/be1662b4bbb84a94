import { routes } from "@/config/routes";
import { STATUS_CODES } from "@/config/status-codes";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { redirectWithCode, routeRedirectWithCode } from "@/lib/utils/redirect-with-code";
import { isGuestOnlyMode } from "@/server/auth-providers";
import { authOptions } from "@/server/auth.config";
import { db } from "@/server/db";
import { accounts, sessions, users, verificationTokens } from "@/server/db/schema";
import type { UserRole } from "@/types/user";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import NextAuth from "next-auth";
import { cache } from "react";

/**
 * Module augmentation for `next-auth` types. Allows us to add custom properties to the `session`
 * object and keep type safety.
 *
 * @see https://next-auth.js.org/getting-started/typescript#module-augmentation
 */

/**
 * Using database session strategy with credentials provider requires special handling:
 * 1. The credentials provider must create a user in the database
 * 2. The user must be properly linked between Payload CMS and Shipkit
 * 3. The session must be created in the database
 *
 * This is handled in:
 * - auth.providers.ts: The credentials provider's authorize function
 * - auth-service.ts: The validateCredentials and ensureUserSynchronized methods
 * - auth.config.ts: The signIn callback
 *
 * For guest users:
 * - JWT strategy is used since guest users don't persist in the database
 * - No adapter is used when in guest-only mode
 */
// Determine if we should use database adapter
const shouldUseDatabaseAdapter = env?.DATABASE_URL && db && !isGuestOnlyMode;

const {
	auth: nextAuthAuth,
	handlers,
	signIn,
	signOut,
	unstable_update: update,
} = NextAuth({
	...authOptions,
	secret: env.AUTH_SECRET ?? "supersecretshipkit",
	// Override session strategy based on adapter usage
	session: {
		...authOptions.session,
		strategy: shouldUseDatabaseAdapter ? "database" : "jwt",
	},
	// Use database adapter only when not in guest-only mode and database is available
	adapter: shouldUseDatabaseAdapter
		? DrizzleAdapter(db as any, {
				usersTable: users,
				accountsTable: accounts,
				sessionsTable: sessions,
				verificationTokensTable: verificationTokens,
			})
		: undefined,
	logger: {
		error: (code: Error, ...message: unknown[]) => {
			logger.error(code, message);
		},
		warn: (code: string, ...message: unknown[]) => {
			logger.warn(code, message);
		},
		debug: (code: string, ...message: unknown[]) => {
			logger.debug(code, message);
		},
	},
});
interface AuthProps {
	errorCode?: string;
	nextUrl?: string;
	protect?: boolean;
	redirect?: boolean;
	redirectTo?: string;
	role?: UserRole;
}

/**
 * Enhanced authentication function with redirect functionality
 * @param props - Authentication properties including redirect options
 */
const authWithOptions = async (props?: AuthProps) => {
	const session = await nextAuthAuth();
	const { errorCode, redirect, nextUrl } = props ?? {};

	// Route protected
	const protect = props?.protect ?? props?.redirectTo !== undefined ?? redirect ?? false;
	const redirectTo = props?.redirectTo ?? routes.auth.signOutIn;

	const handleRedirect = (code: string) => {
		logger.warn(`[authWithOptions] Redirecting to ${redirectTo} with code ${code}`);

		// Determine if we're in a route handler context
		const isFromRouteHandler = typeof Response !== "undefined" && typeof window === "undefined";

		if (isFromRouteHandler) {
			return routeRedirectWithCode(redirectTo, {
				code,
				nextUrl,
			});
		}

		return redirectWithCode(redirectTo, {
			code,
			nextUrl,
		});
	};

	// TODO: Handle refresh token error
	// if (session?.error === "RefreshTokenError") {
	//   return handleRedirect(STATUS_CODES.AUTH_REFRESH.code);
	// }

	if (protect && !session?.user?.id) {
		return handleRedirect(errorCode ?? STATUS_CODES.AUTH.code);
	}

	// TODO: RBAC
	// if (role && session?.user?.role !== role) {
	//   return handleRedirect(errorCode ?? STATUS_CODES.AUTH_ROLE.code); // TODO: We shouldn't sign them out
	// }

	return session;
};

const authenticated = cache(async (props?: AuthProps) => {
	const session = await authWithOptions({ protect: true, ...props });
	return session;
});

const cachedAuth = cache(authWithOptions);

export { cachedAuth as auth, authenticated, handlers, signIn, signOut, update };

// TODO: Dedupe like this from create-t3-turbo:
// import { cache } from "react";
// import NextAuth from "next-auth";

// import { authConfig } from "./config";

// export type { Session } from "next-auth";

// const { handlers, auth: defaultAuth, signIn, signOut } = NextAuth(authConfig);

// /**
//  * This is the main way to get session data for your RSCs.
//  * This will de-duplicate all calls to next-auth's default `auth()` function and only call it once per request
//  */
// const auth = cache(defaultAuth);

// export { handlers, auth, signIn, signOut };

// export {
//     invalidateSessionToken,
//     validateToken,
//     isSecureContext,
// } from "./config";
