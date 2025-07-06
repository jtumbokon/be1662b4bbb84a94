"use server";

import { routes } from "@/config/routes";
import { auth } from "@/server/auth";
import { createTemporaryLink, getTemporaryLinkData } from "@/server/services/temporary-links";
import { redirect } from "next/navigation";
import { isSession } from "@/types/user";

export const generateTemporaryLink = async ({
	data = "hello",
	userId,
}: {
	data?: string;
	userId: string;
}) => {
	const link = await createTemporaryLink({ data, userId, type: "download" });
	if (!link || link.length === 0) {
		throw new Error("Failed to create temporary link");
	}
	return link[0].id;
};

export const getTemporaryLink = async (linkId: string) => {
	const sessionOrResponse = await auth();
	if (!isSession(sessionOrResponse)) {
		redirect(routes.auth.signIn);
	}
	const session = sessionOrResponse;

	return await getTemporaryLinkData(linkId, session.user.id);
};
