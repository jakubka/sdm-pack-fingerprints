/*
 * Copyright © 2018 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    GitProject,
    guid,
    logger,
    Parameter,
    Parameters,
} from "@atomist/automation-client";
import {
    CodeTransform,
    CodeTransformRegistration,
} from "@atomist/sdm";
import { SlackMessage } from "@atomist/slack-messages";
import * as fingerprints from "../../fingerprints/index";
import { FP } from "../../fingerprints/index";
import { queryPreferences } from "../adhoc/preferences";
import {
    EditModeMaker,
    FingerprintRegistration,
} from "../machine/FingerprintSupport";
import { footer } from "../support/util";

@Parameters()
export class ApplyTargetFingerprintParameters {

    @Parameter({ required: false, displayable: false })
    public msgId?: string;

    @Parameter({ required: true })
    public fingerprint: string;
}

async function pusher( message: (s: string) => Promise<any>, p: GitProject, registrations: FingerprintRegistration[], fp: FP) {

    logger.info(`transform running -- ${fp} --`);

    for (const registration of registrations) {
        if (registration.apply && registration.selector(fp)) {
            const result: boolean = await registration.apply(p, fp);
            if (!result) {
                await message(`failure applying fingerprint ${fp.name}`);
            }
        }
    }

    await fingerprints.applyFingerprint(p.baseDir, fp);

    return p;
}

function applyFingerprint( registrations: FingerprintRegistration[]): CodeTransform<ApplyTargetFingerprintParameters> {
    return async (p, cli) => {

        const targets = cli.parameters as any

        const message: SlackMessage = {
            attachments: [
                {
                    author_name: "Apply target fingerprint",
                    author_icon: `https://images.atomist.com/rug/check-circle.gif?gif=${guid()}`,
                    text: `Applying target fingerprint \`${cli.parameters.fingerprint}\` to <https://github.com/${
                        targets["targets.owner"]}/${targets["targets.repo"]}|${targets["targets.owner"]}/${targets["targets.repo"]}>`,
                    mrkdwn_in: ["text"],
                    color: "#45B254",
                    fallback: "none",
                    footer: footer(),
                },
            ],
        };

        await cli.addressChannels(message);

        return pusher(
            async (s: string) => cli.addressChannels(s),
            (p as GitProject),
            registrations,
            await fingerprints.getFingerprintPreference(
                queryPreferences(cli.context.graphClient),
                cli.parameters.fingerprint));
    };
}
export let ApplyTargetFingerprint: CodeTransformRegistration<ApplyTargetFingerprintParameters>;

export function applyTargetFingerprint(
    registrations: FingerprintRegistration[],
    presentation: EditModeMaker ): CodeTransformRegistration<ApplyTargetFingerprintParameters> {
    ApplyTargetFingerprint = {
        name: "ApplyTargetFingerprint",
        intent: "applyFingerprint",
        description: "choose to raise a PR on the current project to apply a target fingerprint",
        paramsMaker: ApplyTargetFingerprintParameters,
        transformPresentation: presentation,
        transform: applyFingerprint(registrations),
    };
    return ApplyTargetFingerprint;
}
