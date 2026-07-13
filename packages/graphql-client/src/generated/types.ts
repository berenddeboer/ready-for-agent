export default {
    "scalars": [
        1,
        3,
        4
    ],
    "types": {
        "Query": {
            "health": [
                1
            ],
            "repositories": [
                2
            ],
            "__typename": [
                4
            ]
        },
        "Boolean": {},
        "Repository": {
            "id": [
                3
            ],
            "githubOwner": [
                4
            ],
            "githubRepo": [
                4
            ],
            "localPath": [
                4
            ],
            "isBare": [
                1
            ],
            "paused": [
                1
            ],
            "__typename": [
                4
            ]
        },
        "ID": {},
        "String": {},
        "AddRepositoryInput": {
            "githubOwner": [
                4
            ],
            "githubRepo": [
                4
            ],
            "localPath": [
                4
            ],
            "isBare": [
                1
            ],
            "__typename": [
                4
            ]
        },
        "Mutation": {
            "addRepository": [
                2,
                {
                    "input": [
                        5,
                        "AddRepositoryInput!"
                    ]
                }
            ],
            "__typename": [
                4
            ]
        }
    }
}