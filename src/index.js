// index.js

import api, { route } from '@forge/api';
import { storage } from '@forge/api';

/**
 * 1. Action Handler: get-user-details-action
 * Retrieves information about the bug reporter (e.g., subscription tier).
 * @param {object} event - The Forge event object containing action inputs.
 * @returns {object} Structured user data for the LLM.
 */
export async function getUserDetails(event) {
    const { user_id } = event.payload;

    // --- Implementation Details (Conceptual) ---
    // 1. Call an external CRM API using fetch to get user data.
    // 2. Use user_id to look up customer tier and recent support volume.
    // 3. This data helps the LLM calculate Priority.

    try {
        // Example: Fetch from a hypothetical external CRM API
        const response = await fetch(`https://api.your-crm.com/users/${user_id}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${await storage.getSecret('CRM_API_KEY')}`
            }
        });

        if (!response.ok) {
            console.error(`Error fetching user details for ${user_id}: ${response.statusText}`);
            // Return a default value to prevent Agent failure
            return { tier: 'Standard', priority_modifier: 'P3_Neutral' };
        }

        const data = await response.json();

        // Return a structured object for the Rovo Agent to use in its reasoning
        return {
            tier: data.subscription_level || 'Standard', // e.g., 'Enterprise', 'Standard'
            priority_modifier: data.subscription_level === 'Enterprise' ? 'P1_Critical' : 'P3_Neutral',
            // Add other relevant data like is_executive, recent_bug_count
        };

    } catch (error) {
        console.error('getUserDetails failed:', error);
        // Fallback: Assume standard priority if the service is unreachable
        return { tier: 'Standard', priority_modifier: 'P3_Neutral' };
    }
}

/**
 * 2. Action Handler: search-codebase-action
 * Searches code/repo for files related to the bug report to determine the component/team.
 * @param {object} event - The Forge event object containing action inputs.
 * @returns {object} Structured code component/assignment data.
 */
export async function searchCodebase(event) {
    const { keywords } = event.payload;
    const repo_slug = 'sobta-core-repo'; // Placeholder: Should be configured

    // --- Implementation Details (Conceptual) ---
    // 1. Use the keywords to query the Bitbucket or GitHub API.
    // 2. Map file path results (e.g., 'src/auth/login.js') to team components.

    try {
        // Example: Querying a Bitbucket Repository API for code search
        const query = encodeURIComponent(keywords);
        const url = `https://api.bitbucket.org/2.0/repositories/your-workspace/${repo_slug}/search/code?q=${query}`;

        const response = await fetch(url, {
            method: 'GET',
            // Use Forge's built-in OAuth/App permissions or a service token
            headers: {
                'Authorization': `Bearer ${await storage.getSecret('BITBUCKET_API_TOKEN')}`
            }
        });

        if (!response.ok) {
            console.error(`Codebase search failed: ${response.statusText}`);
            return { component: 'Unassigned', team: 'Triage_Team' };
        }

        const data = await response.json();

        // Simple mapping logic: map file paths to teams/components
        const first_match = data.values?.[0]?.file?.path;
        let component = 'Unassigned';
        let team = 'Triage_Team';

        if (first_match) {
            if (first_match.includes('auth')) {
                component = 'Authentication';
                team = 'Team-Ares';
            } else if (first_match.includes('billing')) {
                component = 'Billing/Payments';
                team = 'Team-Zeus';
            }
            // The LLM uses this output to populate the final ticket fields
        }

        return { component, team, path: first_match || 'No path found' };

    } catch (error) {
        console.error('searchCodebase failed:', error);
        return { component: 'Unassigned', team: 'Triage_Team' };
    }
}

/**
 * 3. Action Handler: create-jira-ticket-action
 * Creates the final, triaged Jira ticket using the data synthesized by the Rovo Agent.
 * @param {object} event - The Forge event object containing action inputs.
 * @returns {object} Success or failure message.
 */
export async function createJiraTicket(event) {
    const { summary, description, priority, component, assignee_id } = event.payload;
    const projectKey = 'PROJ'; // Replace with your target Jira project key

    // --- Implementation Details (Conceptual) ---
    // 1. Use the @forge/api to call the Jira REST API.
    // 2. Use the priority, component, and assignee_id determined by the Agent.

    try {
        const payload = {
            fields: {
                project: { key: projectKey },
                summary: `[SOBTA Triage] ${summary}`,
                description: {
                    type: 'doc',
                    version: 1,
                    content: [
                        {
                            type: 'paragraph',
                            content: [{ type: 'text', text: description }]
                        },
                        {
                            type: 'paragraph',
                            content: [{ type: 'text', text: `--- Triage Context ---` }]
                        },
                        {
                            type: 'paragraph',
                            content: [{ type: 'text', text: `Component Determined: ${component}` }]
                        },
                    ],
                },
                issuetype: { name: 'Bug' },
                priority: { name: priority }, // e.g., 'Highest', 'High', 'Medium'
                components: [{ name: component }],
                assignee: assignee_id ? { id: assignee_id } : { name: 'unassigned' }
            }
        };

        const response = await api.asApp().requestJira(route`/rest/api/3/issue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Jira API failed to create issue: ${response.status} - ${errorText}`);
        }

        const issue = await response.json();
        console.log(`Successfully created triaged issue: ${issue.key}`);
        
        // This success message is returned to the Rovo Agent's execution log/trajectory
        return { success: true, issue_key: issue.key, message: `Jira ticket ${issue.key} successfully created and triaged to ${component} with priority ${priority}.` };

    } catch (error) {
        console.error('createJiraTicket failed:', error);
        return { success: false, message: `Failed to create Jira ticket: ${error.message}` };
    }
}