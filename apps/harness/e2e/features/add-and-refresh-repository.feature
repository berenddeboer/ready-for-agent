Feature: Add and refresh a Repository
  Operators add a local checkout through the CLI and rely on credential
  activation's automatic first Refresh Job to surface Relevant Issues.

  Scenario: Add and refresh a Repository
    Given the Harness has no configured Repositories
    And the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    Then the Repository appears in the Harness
    And the sentinel Issue appears after the automatic first Refresh Job
