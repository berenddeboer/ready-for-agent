export default {
    "scalars": [
        1,
        3,
        5,
        7
    ],
    "types": {
        "Query": {
            "health": [
                1
            ],
            "repositories": [
                4
            ],
            "config": [
                2
            ],
            "__typename": [
                3
            ]
        },
        "Boolean": {},
        "Config": {
            "defaultModel": [
                3
            ],
            "defaultVariant": [
                3
            ],
            "__typename": [
                3
            ]
        },
        "String": {},
        "Repository": {
            "id": [
                5
            ],
            "githubOwner": [
                3
            ],
            "githubRepo": [
                3
            ],
            "localPath": [
                3
            ],
            "isBare": [
                1
            ],
            "paused": [
                1
            ],
            "__typename": [
                3
            ]
        },
        "ID": {},
        "RepositoryRefresh": {
            "fetched": [
                7
            ],
            "inserted": [
                7
            ],
            "updated": [
                7
            ],
            "deleted": [
                7
            ],
            "unchanged": [
                7
            ],
            "__typename": [
                3
            ]
        },
        "Int": {},
        "AddRepositoryInput": {
            "githubOwner": [
                3
            ],
            "githubRepo": [
                3
            ],
            "localPath": [
                3
            ],
            "isBare": [
                1
            ],
            "__typename": [
                3
            ]
        },
        "UpdateConfigInput": {
            "defaultModel": [
                3
            ],
            "defaultVariant": [
                3
            ],
            "__typename": [
                3
            ]
        },
        "Mutation": {
            "addRepository": [
                4,
                {
                    "input": [
                        8,
                        "AddRepositoryInput!"
                    ]
                }
            ],
            "refreshRepository": [
                6,
                {
                    "repositoryId": [
                        5,
                        "ID!"
                    ]
                }
            ],
            "updateConfig": [
                2,
                {
                    "input": [
                        9,
                        "UpdateConfigInput!"
                    ]
                }
            ],
            "__typename": [
                3
            ]
        }
    }
}