import { cruise } from 'dependency-cruiser';

export interface CircularDependency {
    type: 'circular';
    path: string[];
}

export async function analyzeRepository(repoPath: string): Promise<CircularDependency[]> {
    try {
        const result = await cruise(
            [repoPath],
            {
                exclude: {
                    path: [
                        "node_modules",
                        "dist",
                        "coverage",
                        "build",
                        "\\.git",
                        "\\.next",
                        "\\.cache"
                    ]
                },
                includeOnly: {
                    path: ["\\.(js|jsx|ts|tsx)$"]
                },
                validate: true,
                ruleSet: {
                    forbidden: [
                        {
                            name: "no-circular",
                            severity: "warn",
                            from: {},
                            to: { circular: true }
                        }
                    ]
                }
            }
        );

        const circularDependencies: CircularDependency[] = [];

        if (result.output.summary.violations) {
            for (const violation of result.output.summary.violations) {
                if (violation.rule.name === 'no-circular') {
                    const cyclePath = [];
                    if (violation.type === 'cycle' && (violation as any).cycle) {
                        cyclePath.push(violation.from);
                        cyclePath.push(...(violation as any).cycle.map((c: any) => c.name));
                    } else {
                        cyclePath.push(violation.from, violation.to);
                    }
                    
                    circularDependencies.push({
                        type: 'circular',
                        path: cyclePath
                    });
                }
            }
        }

        return circularDependencies;
    } catch (e) {
        console.error("Error analyzing repository:", e);
        throw e;
    }
}

if (typeof require !== 'undefined' && require.main === module) {
    const targetPath = process.argv[2] || '.';
    analyzeRepository(targetPath).then(result => {
        console.log(JSON.stringify(result, null, 2));
    }).catch(err => {
        process.exit(1);
    });
}
