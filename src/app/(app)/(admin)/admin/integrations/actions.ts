"use server";

import { getPayloadClient } from "@/lib/payload/payload";
import { seedAllDirect } from "@/lib/payload/seed-utils";
import { auth } from "@/server/auth";
import { isAdmin } from "@/server/services/admin-service";
import { isSession } from "@/types/user";

/**
 * Server action to seed the CMS with initial data
 * Only works in production with a valid admin secret
 */
export async function seedCMSAction() {
	const sessionOrResponse = await auth();

	if (!isSession(sessionOrResponse)) {
		throw new Error("Unauthorized");
	}

	const session = sessionOrResponse;

	if (!isAdmin({ email: session?.user?.email })) {
		throw new Error("Unauthorized");
	}

	try {
		// Get the payload client
		const payload = await getPayloadClient();
		if (!payload) {
			throw new Error("Payload CMS is not enabled");
		}

		// Run the direct seed function
		await seedAllDirect(payload);

		return { success: true, message: "CMS seeded successfully" };
	} catch (error) {
		console.error("Error seeding CMS:", error);
		return {
			success: false,
			message: error instanceof Error ? error.message : "Unknown error occurred",
		};
	}
}

/**
 * Server action to check the configuration status of the CMS.
 */
export async function getCMSStatusAction() {
	const sessionOrResponse = await auth();

	if (!isSession(sessionOrResponse)) {
		// Return a specific status for unauthorized access
		return { configured: false, message: "Unauthorized to check status." };
	}

	const session = sessionOrResponse;

	if (!isAdmin({ email: session?.user?.email })) {
		// Return a specific status for unauthorized access
		return { configured: false, message: "Unauthorized to check status." };
	}

	const payloadSecret = process.env.PAYLOAD_SECRET;
	const databaseUrl = process.env.DATABASE_URL;
	// Check the feature flag as well
	const isPayloadEnabled = process.env.NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED === "true";

	if (payloadSecret && databaseUrl && isPayloadEnabled) {
		return {
			configured: true,
			message:
				"CMS is enabled and configured (Feature flag, PAYLOAD_SECRET, and DATABASE_URL are set).",
		};
	}

	const missingVars = [];
	if (!payloadSecret) missingVars.push("PAYLOAD_SECRET");
	if (!databaseUrl) missingVars.push("DATABASE_URL");
	if (!isPayloadEnabled) missingVars.push("NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED (should be 'true')");

	let message = `CMS configuration incomplete. Missing environment variables: ${missingVars.join(
		", "
	)}.`;

	if (!isPayloadEnabled && payloadSecret && databaseUrl) {
		message =
			"CMS backend is configured (Secrets set), but the feature flag NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED is not 'true'.";
	}

	return {
		configured: false,
		message,
	};
}
