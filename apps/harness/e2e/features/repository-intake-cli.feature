@live-forge
Feature: Repository Intake CLI automation
  Automated operators discover Intake Candidates, start them through
  Repository Intake, and inspect Kanban status through the compiled CLI and
  real GraphQL endpoint.

  Scenario: candidates then intake then status for a Fixture Repository
    Given the Harness has no configured Repositories
    And the Harness has a configured default build model
    And the End-to-End Fixture Repository is checked out
    When I add the Repository with the CLI
    Then the Repository appears in the Harness
    And the sentinel Issue appears after the automatic first Refresh Job
    When I run candidates for the Fixture Repository with the CLI
    Then candidates JSON includes the sentinel Issue as IMPLEMENT_NOW
    When I run intake for the Fixture Repository with the CLI
    Then intake JSON creates a Work Item for the sentinel Issue
    When I run status for the Fixture Repository with the CLI
    Then status JSON includes the sentinel Work Item
    When I run candidates for the Fixture Repository with the CLI again
    Then candidates JSON omits the sentinel Issue
    And I clean up Work Items created by Intake
